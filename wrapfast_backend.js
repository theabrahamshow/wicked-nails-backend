const express = require('express')
const rateLimit = require('express-rate-limit')
const crypto = require('crypto')
const axios = require('axios')
const OpenAI = require('openai')
const { GoogleGenAI } = require('@google/genai')
const path = require('path')
require('assert')
const https = require('https')
require('dotenv').config({ path: path.join(__dirname, '.env') })
const app = express()

// Trust proxy - required for rate limiting behind Render's reverse proxy
app.set('trust proxy', 1)

// Change the port if you need it.
const port = 10000

const chatUrl = 'https://api.openai.com/v1/chat/completions'
const dalleUrl = 'https://api.openai.com/v1/images/generations'
const anthropicMessagesUrl = 'https://api.anthropic.com/v1/messages'
const rateLimitErrorCode = 'rate_limit_exceeded'
const wrapFastAppIdentifier = 'wrapfast'

// Environment variables
const apiKey = process.env.API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const AUTH_SECRET_KEY = process.env.AUTH_SECRET_KEY
const HMAC_SECRET_KEY = process.env.HMAC_SECRET_KEY
const AUTH_LIMIT = process.env.AUTH_LIMIT
const PROMPT_LIMIT = process.env.PROMPT_LIMIT
const VISION_MAX_TOKENS = parseInt(process.env.VISION_MAX_TOKENS, 10) || 1000
const ANTHROPIC_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10) || 1000
const telegramBotKey = process.env.TELEGRAM_BOT_KEY
const channelId = process.env.TELEGRAM_CHANNEL_ID
const HIKERAPI_ACCESS_KEY = process.env.HIKERAPI_ACCESS_KEY

// Credits constants
const FREE_USER_CREDITS = 0 // Free users get 0 credits (demo is separate)
const WEEKLY_SUBSCRIPTION_CREDITS = 15
const MONTHLY_SUBSCRIPTION_CREDITS = 60
const ANNUAL_SUBSCRIPTION_CREDITS = 60 // Same as monthly, resets monthly
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET
const REVENUECAT_API_KEY = process.env.REVENUECAT_API_KEY // Secret API key from RevenueCat dashboard

// =============================================================================
// PERSISTENT USAGE TRACKING via RevenueCat Subscriber Attributes
// =============================================================================
// RevenueCat stores custom attributes per subscriber, which persist across:
// - App reinstalls
// - Server restarts/deploys
// - Device changes (tied to StableID)
// =============================================================================

// In-memory cache for subscriber data (reduces RevenueCat API calls)
const subscriberCache = new Map()
const CACHE_TTL_MS = 10 * 1000 // 10 seconds cache (short for responsiveness)

// Helper to get the start of current week (Sunday)
function getWeekStart() {
  const now = new Date()
  const dayOfWeek = now.getUTCDay()
  const startOfWeek = new Date(now)
  startOfWeek.setUTCDate(now.getUTCDate() - dayOfWeek)
  startOfWeek.setUTCHours(0, 0, 0, 0)
  return startOfWeek.toISOString()
}

// Check if we need to reset weekly credits (new week started)
function checkAndResetWeekly(usage, userId) {
  const currentWeekStart = getWeekStart()
  if (usage.weekStart !== currentWeekStart) {
    // New week - reset credits
    console.log(`🔄 New week detected for ${userId}, resetting weekly credits`)
    usage.weeklyUsed = 0
    usage.weekStart = currentWeekStart
    // Save the reset asynchronously
    saveUserUsage(userId, usage).catch(err => console.error('Failed to save weekly reset:', err))
  }
  return usage
}

// Get user usage from RevenueCat subscriber attributes
async function getUserUsage(userId) {
  // Check cache first
  const cached = subscriberCache.get(userId)
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return checkAndResetWeekly(cached.usage, userId)
  }
  
  // Fetch from RevenueCat
  try {
    const response = await axios.get(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      {
        headers: {
          'Authorization': `Bearer ${REVENUECAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )
    
    const subscriber = response.data.subscriber
    const attrs = subscriber.subscriber_attributes || {}
    
    // Parse usage from subscriber attributes (with defaults)
    const usage = {
      weeklyUsed: parseInt(attrs.wicked_weekly_used?.value || '0', 10),
      weekStart: attrs.wicked_week_start?.value || getWeekStart(),
      purchasedCredits: parseInt(attrs.wicked_purchased_credits?.value || '0', 10),
      demoUsed: attrs.wicked_demo_used?.value === 'true',
      // Get subscription info from entitlements
      isSubscribed: Object.keys(subscriber.entitlements?.active || {}).length > 0,
      subscriptionType: getSubscriptionTypeFromEntitlements(subscriber.entitlements?.active),
      expiresAt: getExpirationFromEntitlements(subscriber.entitlements?.active)
    }
    
    // Cache the result
    subscriberCache.set(userId, { usage, timestamp: Date.now() })
    
    return checkAndResetWeekly(usage, userId)
  } catch (error) {
    if (error.response?.status === 404) {
      // New user - return defaults
      const usage = {
        weeklyUsed: 0,
        weekStart: getWeekStart(),
        purchasedCredits: 0,
        demoUsed: false,
        isSubscribed: false,
        subscriptionType: null,
        expiresAt: null
      }
      subscriberCache.set(userId, { usage, timestamp: Date.now() })
      return usage
    }
    console.error('Failed to fetch subscriber from RevenueCat:', error.message)
    throw error
  }
}

// Extract subscription type from active entitlements
function getSubscriptionTypeFromEntitlements(activeEntitlements) {
  if (!activeEntitlements || Object.keys(activeEntitlements).length === 0) {
    return null
  }
  // Look at the product identifier to determine type
  for (const entitlement of Object.values(activeEntitlements)) {
    const productId = (entitlement.product_identifier || '').toLowerCase()
    if (productId.includes('lifetime')) return 'lifetime'
    if (productId.includes('annual') || productId.includes('yearly')) return 'annual'
    if (productId.includes('month')) return 'monthly'
    if (productId.includes('week')) return 'weekly'
  }
  return 'weekly' // Default
}

// Get expiration date from active entitlements
function getExpirationFromEntitlements(activeEntitlements) {
  if (!activeEntitlements || Object.keys(activeEntitlements).length === 0) {
    return null
  }
  for (const entitlement of Object.values(activeEntitlements)) {
    if (entitlement.expires_date) {
      return entitlement.expires_date
    }
  }
  return null
}

// Save usage to RevenueCat subscriber attributes (PERSISTENT!)
async function saveUserUsage(userId, usage) {
  try {
    await axios.post(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}/attributes`,
      {
        attributes: {
          wicked_weekly_used: { value: String(usage.weeklyUsed) },
          wicked_week_start: { value: usage.weekStart },
          wicked_purchased_credits: { value: String(usage.purchasedCredits) },
          wicked_demo_used: { value: usage.demoUsed ? 'true' : 'false' }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${REVENUECAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )
    
    // Update cache
    subscriberCache.set(userId, { usage, timestamp: Date.now() })
    console.log(`💾 Saved usage to RevenueCat for ${userId}`)
  } catch (error) {
    console.error('Failed to save subscriber attributes:', error.message)
    throw error
  }
}

// Invalidate cache for a user (used after webhook events)
function invalidateUserCache(userId) {
  subscriberCache.delete(userId)
  console.log(`🗑️ Cache invalidated for ${userId}`)
}

// Get credits remaining for a user
function getCreditsRemaining(usage) {
  if (!usage.isSubscribed) {
    // Not subscribed - only purchased credits available
    return usage.purchasedCredits
  }
  
  // Get total credits based on subscription type
  let totalCredits
  switch (usage.subscriptionType) {
    case 'weekly':
      totalCredits = WEEKLY_SUBSCRIPTION_CREDITS
      break
    case 'monthly':
    case 'annual':
      totalCredits = MONTHLY_SUBSCRIPTION_CREDITS
      break
    case 'lifetime':
      totalCredits = 9999 // Effectively unlimited
      break
    default:
      totalCredits = WEEKLY_SUBSCRIPTION_CREDITS
  }
  
  // Subscription credits + purchased credits - used
  const subscriptionRemaining = Math.max(0, totalCredits - usage.weeklyUsed)
  return subscriptionRemaining + usage.purchasedCredits
}

// Get user credits info for API response
async function getUserCreditsInfo(userId) {
  try {
    const usage = await getUserUsage(userId)
    const creditsRemaining = getCreditsRemaining(usage)
    
    // Determine total credits for display
    let totalCredits = usage.purchasedCredits
    if (usage.isSubscribed) {
      switch (usage.subscriptionType) {
        case 'weekly':
          totalCredits += WEEKLY_SUBSCRIPTION_CREDITS
          break
        case 'monthly':
        case 'annual':
          totalCredits += MONTHLY_SUBSCRIPTION_CREDITS
          break
        case 'lifetime':
          totalCredits += 9999
          break
        default:
          totalCredits += WEEKLY_SUBSCRIPTION_CREDITS
      }
    }
    
    return {
      creditsRemaining,
      creditsTotal: totalCredits,
      subscriptionStatus: usage.isSubscribed ? 'active' : 'none',
      subscriptionType: usage.subscriptionType,
      resetsAt: usage.isSubscribed ? getNextWeekStart() : null,
      demoUsed: usage.demoUsed
    }
  } catch (error) {
    console.error('Failed to get user credits info:', error.message)
    return {
      creditsRemaining: 0,
      creditsTotal: 0,
      subscriptionStatus: 'none',
      subscriptionType: null,
      resetsAt: null,
      demoUsed: false
    }
  }
}

// Get the start of next week (for reset display)
function getNextWeekStart() {
  const now = new Date()
  const dayOfWeek = now.getUTCDay()
  const daysUntilNextSunday = 7 - dayOfWeek
  const nextWeek = new Date(now)
  nextWeek.setUTCDate(now.getUTCDate() + daysUntilNextSunday)
  nextWeek.setUTCHours(0, 0, 0, 0)
  return nextWeek.toISOString()
}

// Initialize OpenAI client (optional - only if API key is provided)
let openai = null
if (apiKey && apiKey !== 'sk-placeholder-not-used') {
  openai = new OpenAI({ apiKey })
  console.log('OpenAI client initialized')
} else {
  console.log('OpenAI client not initialized (no valid API key)')
}

// Initialize Gemini client (required for nail try-on)
let geminiClient = null
if (GEMINI_API_KEY) {
  geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  console.log('Gemini client initialized')
} else {
  console.error('Gemini API key not found - nail try-on will not work')
}

if (!HMAC_SECRET_KEY) {
  console.error('HMAC secret key not found')
  process.exit(1)
}

// Rate limits each 5 minutes. Tweak it if you need.
// These limits prevents abusing of the OpenAI requests.
const promptLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: PROMPT_LIMIT
})

const authtLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: AUTH_LIMIT
})

// POST endpoints to send requests to OpenAI APIs
app.use('/vision', promptLimiter)
app.use('/chatgpt', promptLimiter)
app.use('/dalle', promptLimiter)
app.use('/gpt-image', promptLimiter)
app.use('/gpt-image-edits', promptLimiter)
// POST endpoints to send requests to Anthropic APIs
app.use('/anthropic-messages', promptLimiter)
// POST endpoint for Gemini nail try-on
app.use('/nail-tryon', promptLimiter)
// POST endpoint for Instagram media extraction via HikerAPI
app.use('/instagram-media', promptLimiter)
// POST endpoint for feedback alerts to Telegram
app.use('/feedback-alert', promptLimiter)

// GET endpoint to send de hmac secret key
app.use('/auth', authtLimiter)

// Enable Trust Proxy in Express (set to 1 for local development, adjust for production)
// Set to false for local development to avoid rate limit validation errors
app.set('trust proxy', false)

// Verify the HMAC secret keys
const verifyHmacSignature = (req, res, next) => {
  const signature = req.headers['x-signature']

  const dataToSign = req.originalUrl
  const hmac = crypto.createHmac('sha256', req.path === '/auth' ? AUTH_SECRET_KEY : HMAC_SECRET_KEY)
  hmac.update(dataToSign)
  const digest = hmac.digest('hex')

  if (signature === digest) {
    next()
  } else {
    return res.status(401).send('Invalid signature')
  }
}

app.use(express.json({ limit: '10mb' }))

// =============================================================================
// REVENUECAT WEBHOOK ENDPOINT
// Receives subscription events from RevenueCat
// The main job is to INVALIDATE CACHE so next request fetches fresh data
// RevenueCat itself stores the subscription state - we just need to know to refetch
// =============================================================================
app.post('/webhook/revenuecat', async (req, res) => {
  try {
    // Verify Authorization header matches our configured secret
    const authHeader = req.headers['authorization']
    const expectedAuth = REVENUECAT_WEBHOOK_SECRET
    
    if (!expectedAuth) {
      console.error('❌ REVENUECAT_WEBHOOK_SECRET not configured in .env')
      return res.status(500).send('Webhook not configured')
    }
    
    if (!authHeader || authHeader !== expectedAuth) {
      console.warn('⚠️ Unauthorized webhook attempt. Header:', authHeader ? 'present but invalid' : 'missing')
      return res.status(401).send('Unauthorized')
    }
    
    console.log('✅ Webhook authorization verified')

    const event = req.body
    const eventType = event.type
    const appUserId = event.app_user_id // This is the StableID we set
    const productId = event.product_id || ''

    console.log(`\n📥 RevenueCat webhook: ${eventType} for user ${appUserId}`)

    // Invalidate cache for this user so next request fetches fresh data from RevenueCat
    invalidateUserCache(appUserId)

    // Handle credit pack purchases - need to add to subscriber attributes
    if (eventType === 'NON_RENEWING_PURCHASE') {
      // Credit pack or one-time purchase
      // Parse credits from product ID (e.g., "credits_10_pack" -> 10)
      const creditsMatch = productId.match(/(\d+)/)
      const creditsToAdd = creditsMatch ? parseInt(creditsMatch[1], 10) : 10
      
      try {
        // Fetch current usage and add credits
        const usage = await getUserUsage(appUserId)
        usage.purchasedCredits = (usage.purchasedCredits || 0) + creditsToAdd
        await saveUserUsage(appUserId, usage)
        console.log(`💰 Added ${creditsToAdd} purchased credits for ${appUserId}`)
      } catch (error) {
        console.error('Failed to add purchased credits:', error.message)
      }
    }

    // Handle renewal - reset weekly credits
    if (eventType === 'RENEWAL') {
      try {
        const usage = await getUserUsage(appUserId)
        usage.weeklyUsed = 0
        usage.weekStart = getWeekStart()
        await saveUserUsage(appUserId, usage)
        console.log(`🔄 Reset weekly credits for ${appUserId}`)
      } catch (error) {
        console.error('Failed to reset weekly credits:', error.message)
      }
    }

    // Log other event types
    switch (eventType) {
      case 'INITIAL_PURCHASE':
        console.log(`✅ New subscription for ${appUserId}`)
        break
      case 'EXPIRATION':
      case 'CANCELLATION':
        console.log(`❌ Subscription ended for ${appUserId}`)
        break
      case 'BILLING_ISSUE':
        console.log(`⚠️ Billing issue for ${appUserId}`)
        break
      case 'SUBSCRIBER_ALIAS':
        console.log(`🔗 User alias event for ${appUserId}`)
        break
      default:
        console.log(`ℹ️ Handled event type: ${eventType}`)
    }

    // Always return 200 OK quickly to avoid timeouts
    res.status(200).send('OK')
  } catch (error) {
    console.error('RevenueCat webhook error:', error)
    // Still return 200 to prevent RevenueCat from retrying
    res.status(200).send('OK')
  }
})

// =============================================================================
// USER CREDITS ENDPOINT
// Returns current credit balance for a user (iOS app queries this)
// Fetches from RevenueCat (with caching) to get the most accurate data
// =============================================================================
app.get('/user/credits', async (req, res) => {
  try {
    const stableId = req.headers['x-stable-id'] || req.query.stableId

    if (!stableId) {
      return res.status(400).json({ error: 'Missing stableId' })
    }

    const creditsInfo = await getUserCreditsInfo(stableId)
    console.log(`📊 Credits query for ${stableId}: ${creditsInfo.creditsRemaining}/${creditsInfo.creditsTotal}`)

    res.json({
      success: true,
      ...creditsInfo
    })
  } catch (error) {
    console.error('Credits endpoint error:', error)
    res.status(500).json({ error: 'Failed to get credits' })
  }
})

app.use(verifyHmacSignature)

// GPT-4 Vision Endpoint
// It expects a JSON with an image property
// {image: String}
// You can change it or add more properties to handle your special cases.
app.post('/vision', async (req, res) => {
  try {
    let IMAGE = ''
    const appIdentifier = req.get('X-App-Identifier')
    let prompt = ''

    // You can make custom logic here to use this endpoint for several apps and handling what prompts
    // you send to OpenAI's API
    if (appIdentifier === wrapFastAppIdentifier) {
      prompt = buildWrapFastPrompt(req.body)
    }

    IMAGE = req.body.image

    if (!IMAGE) {
      return res.status(400).json({ error: 'Missing "image" in request body' })
    }

    const payload = {
      // You can use the new 'gpt-4o' here
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: prompt
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${IMAGE}`,
                detail: 'low'
              }
            }
          ]
        }
      ],
      max_tokens: VISION_MAX_TOKENS
    }

    try {
      console.log(`\n📸 Requesting image analysis with prompt: ${prompt}`)

      const jsonResponse = await postVisionApi(payload)
      if (jsonResponse.error) {
        return res.status(500).json({ error: jsonResponse.error })
      }

      res.json(jsonResponse)
    } catch (error) {
      if (error === rateLimitErrorCode) {
        res.status(400).json({ error: 'Error response from OpenAI API', details: `Error message: ${error.message} with code: ${error.code}` })
      }

      res.status(500).json({ error: 'Error', details: error.message })
    }
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Request to OpenAI failed', details: error.message })
  }
})

// ChatGPT Endpoint
// It expects a JSON with a prompt property
// {prompt: String}
// You can change it or add more properties to handle your special cases.
// In this example we use the model gpt-4. You can use the model you need.
// Check OpenAI documentation:
// https://platform.openai.com/docs/guides/text-generation
app.post('/chatgpt', async (req, res) => {
  try {
    const prompt = req.body.prompt

    const payload = {
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          // You can set here instructions of how you wish the assistant to behave.
          content: 'You are a helpful assistant.'
        },
        {
          role: 'user',
          // Here you pass the user's prompt to ChatGPT.
          content: prompt
        }
      ]
    }

    try {
      console.log(`\n💬 Requesting ChatGPT prompt: ${prompt}`)

      const jsonResponse = await postChatgptApi(payload)
      if (jsonResponse.error) {
        return res.status(500).json({ error: jsonResponse.error })
      }

      res.json(jsonResponse)
    } catch (error) {
      if (error === rateLimitErrorCode) {
        res.status(400).json({ error: 'Error response from OpenAI API', details: `Error message: ${error.message} with code: ${error.code}` })
      }

      res.status(500).json({ error: 'Error', details: error.message })
    }
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Request to OpenAI failed', details: error.message })
  }
})

// DALL·E Endpoint
// It expects a JSON with a prompt property
// {prompt: String}
// You can change it or add more properties to handle your special cases.
// Check OpenAI documentation:
// https://platform.openai.com/docs/guides/images
app.post('/dalle', async (req, res) => {
  try {
    const imagePrompt = req.body.prompt

    const payload = {
      model: 'dall-e-3',
      prompt: imagePrompt,
      n: 1,
      size: '1024x1024'
    }

    try {
      console.log(`\n🏞️ Requesting image generation to DALL·E with prompt: ${imagePrompt}`)

      const imageURL = await postDalleApi(payload)
      if (imageURL.error) {
        return res.status(500).json({ error: imageURL.error })
      }

      res.json(imageURL)
    } catch (error) {
      if (error === rateLimitErrorCode) {
        res.status(400).json({ error: 'Error response from OpenAI API', details: `Error message: ${error.message} with code: ${error.code}` })
      }

      res.status(500).json({ error: 'Error', details: error.message })
    }
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Request to OpenAI failed', details: error.message })
  }
})

// New GPT Image Generation Endpoint
// It expects a JSON with a prompt property
// {prompt: String}
// You can change it or add more properties to handle your special cases.
// Check OpenAI documentation:
// https://platform.openai.com/docs/guides/image-generation?image-generation-model=gpt-image-1
app.post('/gpt-image', async (req, res) => {
  try {
    const imagePrompt = req.body.prompt

    const payload = {
      model: 'gpt-image-1',
      prompt: imagePrompt,
      size: 'auto', // 1024x1024 (square) 1536x1024 (portrait) 1024x1536 (landscape) auto (default)
      quality: 'medium' // low, medium, high, auto
    }

    try {
      console.log(`\n🏞️ Requesting image generation to GPT Image with prompt: ${imagePrompt}`)

      const imageBase64 = await postGptImageApi(payload)
      if (imageBase64.error) {
        return res.status(500).json({ error: imageBase64.error })
      }

      res.json(imageBase64)
    } catch (error) {
      if (error === rateLimitErrorCode) {
        res.status(400).json({ error: 'Error response from OpenAI API', details: `Error message: ${error.message} with code: ${error.code}` })
      }

      res.status(500).json({ error: 'Error', details: error.message })
    }
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Request to OpenAI failed', details: error.message })
  }
})

// GPT Image Edits Endpoint
// It expects a JSON with the following properties:
// {
//   image: String or Array (base64 encoded image(s) to edit, must be PNG, WEBP, or JPG < 25MB),
//   mask: String (optional base64 encoded mask image),
//   prompt: String (text description of the desired edits, max 32000 chars),
//   size: String (optional, '1024x1024', '1536x1024', '1024x1536', or 'auto'),
//   quality: String (optional, 'high', 'medium', 'low', or 'auto')
// }
// Check OpenAI documentation: https://platform.openai.com/docs/guides/image-generation?image-generation-model=gpt-image-1&lang=javascript
app.post('/gpt-image-edits', async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ error: 'OpenAI service not configured' })
    }

    const { image, mask, prompt, size, quality } = req.body

    if (!image) {
      return res.status(400).json({ error: 'Missing "image" in request body' })
    }

    if (!prompt) {
      return res.status(400).json({ error: 'Missing "prompt" in request body' })
    }

    // GPT-image-1 specific validations
    if (prompt.length > 32000) {
      return res.status(400).json({ error: 'Prompt length must be less than 32000 characters' })
    }
    if (size && !['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(size)) {
      return res.status(400).json({ error: 'Invalid size. Must be one of: 1024x1024, 1536x1024, 1024x1536, auto' })
    }
    if (quality && !['high', 'medium', 'low', 'auto'].includes(quality)) {
      return res.status(400).json({ error: 'Invalid quality. Must be one of: high, medium, low, auto' })
    }

    try {
      console.log(`\n✏️ Requesting image edit with prompt: ${prompt}`)

      // Convert base64 images to File objects
      const imageBuffer = Buffer.from(image, 'base64')
      const imageFile = await OpenAI.toFile(imageBuffer, 'image.png', { type: 'image/png' })

      let maskFile = null
      if (mask) {
        const maskBuffer = Buffer.from(mask, 'base64')
        maskFile = await OpenAI.toFile(maskBuffer, 'mask.png', { type: 'image/png' })
      }

      // Prepare the request payload
      const payload = {
        model: 'gpt-image-1',
        image: imageFile,
        prompt
      }

      // Add optional parameters if provided
      if (maskFile) {
        payload.mask = maskFile
      }
      if (size) {
        payload.size = size
      }
      if (quality) {
        payload.quality = quality
      }

      // Make the API call using the OpenAI client
      const response = await openai.images.edit(payload)

      const imageResponse = {
        imageBase64: response.data[0].b64_json
      }

      res.json(imageResponse)
    } catch (error) {
      if (error.code === rateLimitErrorCode) {
        res.status(400).json({ error: 'Error response from OpenAI API', details: `Error message: ${error.message} with code: ${error.code}` })
      } else {
        res.status(500).json({ error: 'Error', details: error.message })
      }
    }
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Request to OpenAI failed', details: error.message })
  }
})

// Gemini Nail Try-On Endpoint
// Applies nail art design from reference image onto user's hand photo
// Expects:
// {
//   handImage: String (base64 encoded image of user's hand),
//   inspoImage: String (base64 encoded image of nail design inspiration),
//   stableId: String (user's stable ID for server-side credit validation),
//   model: String (optional: 'flash' for faster model)
// }
// Returns:
// {
//   success: Boolean,
//   imageBase64: String (generated image),
//   creditsRemaining: Number,
//   error: String (if error occurred)
// }
app.post('/nail-tryon', async (req, res) => {
  try {
    const { handImage, inspoImage, stableId, model } = req.body
    // Legacy support: also accept old parameters for backwards compatibility during transition
    const { isSubscribed: legacyIsSubscribed, subscriptionType: legacySubType, freeCreditsUsed, plusCreditsUsed } = req.body

    // Determine which model to use: "flash" = 2.5 Flash Image, default = 3 Pro Image
    const useFlashModel = model === 'flash'
    const modelName = useFlashModel ? 'gemini-2.5-flash-image' : 'gemini-3-pro-image-preview'
    console.log(`📱 Using model: ${modelName}`)

    if (!handImage) {
      return res.status(400).json({ success: false, error: 'Missing "handImage" in request body' })
    }

    if (!inspoImage) {
      return res.status(400).json({ success: false, error: 'Missing "inspoImage" in request body' })
    }

    // Server-side credits validation using RevenueCat subscriber attributes
    // Set DEBUG_MODE=true in .env to bypass credit checks during development
    const debugMode = process.env.DEBUG_MODE === 'true'
    
    let creditsRemaining = 0
    let canProceed = false
    let isDemo = false
    let usage = null

    if (debugMode) {
      // Bypass credit check in debug mode
      canProceed = true
      creditsRemaining = 999
      console.log('⚠️ DEBUG MODE: Bypassing credit validation')
    } else if (stableId) {
      // Fetch usage from RevenueCat (with caching)
      try {
        usage = await getUserUsage(stableId)
        creditsRemaining = getCreditsRemaining(usage)
        
        if (creditsRemaining > 0) {
          // User has credits available
          canProceed = true
        } else if (!usage.demoUsed) {
          // User hasn't used their demo yet - allow one free generation
          canProceed = true
          isDemo = true
          console.log(`🎁 Demo generation for user ${stableId}`)
        } else {
          // No credits and demo already used
          canProceed = false
        }
        
        console.log(`👤 User ${stableId}: subscribed=${usage.isSubscribed}, credits=${creditsRemaining}, demoUsed=${usage.demoUsed}`)
      } catch (error) {
        console.error('Failed to fetch user usage:', error.message)
        return res.status(500).json({ success: false, error: 'Failed to verify credits' })
      }
    } else if (legacyIsSubscribed !== undefined) {
      // LEGACY: Fallback to old client-trusted validation (for backwards compatibility)
      console.log('⚠️ Using legacy credit validation (client-trusted)')
      if (legacyIsSubscribed) {
        const totalCredits = legacySubType === 'monthly' ? MONTHLY_SUBSCRIPTION_CREDITS : WEEKLY_SUBSCRIPTION_CREDITS
        creditsRemaining = Math.max(0, totalCredits - (plusCreditsUsed || 0))
        canProceed = creditsRemaining > 0
      } else {
        creditsRemaining = Math.max(0, FREE_USER_CREDITS - (freeCreditsUsed || 0))
        canProceed = creditsRemaining > 0
      }
    } else {
      return res.status(400).json({ success: false, error: 'Missing "stableId" in request body' })
    }

    if (!canProceed) {
      return res.status(403).json({
        success: false,
        error: 'No credits remaining',
        creditsRemaining: 0,
        requiresSubscription: true
      })
    }

    console.log(`\n💅 Requesting nail try-on generation. Credits remaining: ${creditsRemaining}, isDemo: ${isDemo}`)

    // Build the nail try-on prompt
    const nailTryOnPrompt = buildNailTryOnPrompt()

    try {
      // Build the master prompt for nail try-on
      const masterPrompt = `⚠️⚠️⚠️ CRITICAL: BEFORE YOU START, IDENTIFY ALL FINGERS IN THE FIRST IMAGE. Look at the hand image and identify EVERY finger that is visible: 1) THUMB, 2) INDEX FINGER, 3) MIDDLE FINGER, 4) RING FINGER, 5) PINKY FINGER. Write down which fingers you can see. Then apply nail art to EVERY SINGLE ONE.

⚠️ ABSOLUTE REQUIREMENT - READ THIS FIRST: The final image MUST show nail art on ALL 5 FINGERS. Count them: 1) THUMB, 2) INDEX FINGER, 3) MIDDLE FINGER, 4) RING FINGER, 5) PINKY FINGER. If ANY finger is missing nail art, the result is WRONG and must be rejected. Before you finish, verify: thumb has art? index has art? middle has art? ring has art? pinky has art? ALL 5 MUST HAVE NAIL ART. NO EXCEPTIONS.

⚠️⚠️⚠️ CRITICAL INSTRUCTION FOR NAIL ART REPLICATION: Look at the second image (reference nail art) very carefully. Study every detail: the exact colors, the exact glitter type and placement, the exact patterns, the exact textures. Your output nail art must be a PERFECT VISUAL MATCH to the reference. DO NOT use your artistic judgment. DO NOT make it 'better'. DO NOT adjust anything. Your task is SIMPLE: copy the reference nail art exactly as it appears. If the reference has burgundy, use burgundy. If it has chunky gold glitter, use chunky gold glitter. If it has a specific pattern, copy that exact pattern. The reference image is your ONLY source of truth - copy it exactly, without any modifications or interpretations. Before you finish, you MUST compare your output to the reference and ensure they match EXACTLY. If they don't match, you have failed and must fix it.

STEP-BY-STEP PROCESS (FOLLOW EXACTLY):
Step 1: Look at the first image (hand). Identify ALL visible fingers. List them: thumb, index, middle, ring, pinky.
Step 2: For EACH finger you identified in Step 1, create a DIRECT VISUAL COPY of the nail art from the corresponding finger in the second image. Look at the reference finger, then copy what you see - the exact colors, exact glitter, exact pattern. DO NOT interpret. DO NOT improve. DO NOT adjust. COPY IT DIRECTLY as it appears in the reference image.
Step 3: After applying art, check: Did you apply art to the thumb? YES/NO. If NO, go back and apply it.
Step 4: Check: Did you apply art to the index finger? YES/NO. If NO, go back and apply it.
Step 5: Check: Did you apply art to the middle finger? YES/NO. If NO, go back and apply it.
Step 6: Check: Did you apply art to the ring finger? YES/NO. If NO, go back and apply it.
Step 7: Check: Did you apply art to the pinky finger? YES/NO. If NO, go back and apply it.
Step 8: Only when ALL 5 checks are YES can you finish. If ANY check is NO, you must go back and fix it.

Instructions: Apply the EXACT nail art design from the second image onto the fingernails of the hand in the first image.

CRITICAL CONSTRAINTS:
1. DO NOT change the hand structure, skin tone, lighting, or shape of the fingers.
2. DO NOT change the background - keep it exactly as it is.
3. ONLY modify the fingernail area - apply the nail art pattern precisely.
4. EXACT VISUAL MATCHING - DIRECT COPY - NO INTERPRETATION: This is THE MOST CRITICAL requirement. Your output nail art must be a DIRECT VISUAL COPY of the reference nail art. Think of yourself as a photocopier - you are copying the visual appearance, not interpreting or recreating it. DO NOT make ANY modifications, adjustments, improvements, simplifications, reinterpretations, or creative changes. DO NOT 'improve' the design. DO NOT 'balance' the elements. DO NOT 'clean up' the pattern. DO NOT make it 'more polished'. Your ONLY job is to copy what you see in the reference. The output nail art must match the reference nail art in EVERY visual aspect: EXACT same colors (if reference is burgundy, use burgundy - not maroon, not red, not dark red - BURGUNDY), EXACT same glitter type and density (if reference has chunky gold glitter, use chunky gold glitter - not fine, not silver, not less dense), EXACT same patterns (if reference has a specific pattern, copy that EXACT pattern), EXACT same textures, EXACT same gradients, EXACT same decorative elements. Before finalizing, compare your output to the reference: do the colors match? does the glitter match? does the pattern match? If ANYTHING looks different, you have made a modification and must fix it. The reference is the TRUTH - copy it exactly. The only adaptation is following nail curvature, but visually the design must be identical.
5. The nail polish must look photorealistic, glossy, and follow the exact curve of each nail.
6. Preserve all shadows, highlights, and lighting on the hand and background.
7. FINGER-TO-FINGER MAPPING - DIRECT VISUAL COPY REQUIRED: For each finger, you must create a DIRECT VISUAL COPY of the corresponding finger in the reference image. If the reference thumb shows specific nail art, your output thumb must show that EXACT same nail art - same colors, same glitter, same pattern, same everything. Match index to index, middle to middle, ring to ring, pinky to pinky. For each finger, look at the reference finger, then look at your output finger - they must look the SAME. DO NOT interpret the design. DO NOT recreate it with 'improvements'. DO NOT adjust anything. COPY IT DIRECTLY. If the reference thumb has burgundy with chunky gold glitter at the tip, your output thumb must have burgundy with chunky gold glitter at the tip - not maroon, not fine glitter, not different placement. The visual appearance must be IDENTICAL. The design follows the nail curvature naturally, but all visual elements (colors, glitter, patterns) must match the reference EXACTLY.
8. MANDATORY COMPLETE COVERAGE - ALL 5 FINGERS REQUIRED - THIS IS NON-NEGOTIABLE: The final image MUST have nail art applied to ALL 5 fingers. There are exactly 5 fingers on a hand: 1) THUMB, 2) INDEX FINGER, 3) MIDDLE FINGER, 4) RING FINGER, 5) PINKY FINGER. EVERY SINGLE ONE OF THESE 5 FINGERS MUST HAVE NAIL ART. If you can see the finger in the image, its nail MUST have art. Even if a finger is partially visible, partially obscured, in the background, or at an angle, you MUST apply nail art to its visible nail surface. DO NOT SKIP ANY FINGER. DO NOT MISS ANY FINGER. Before finalizing, count: thumb ✓, index ✓, middle ✓, ring ✓, pinky ✓. If the count is not 5/5, the result is INCORRECT and you must fix it. This is the MOST IMPORTANT requirement.
9. FINAL VERIFICATION CHECK - MANDATORY BEFORE COMPLETION: Before you consider the image complete, you MUST perform this check: Look at the final image and identify each finger. 1) Find the thumb - does it have nail art? If NO, add it now. 2) Find the index finger - does it have nail art? If NO, add it now. 3) Find the middle finger - does it have nail art? If NO, add it now. 4) Find the ring finger - does it have nail art? If NO, add it now. 5) Find the pinky finger - does it have nail art? If NO, add it now. Only when ALL 5 fingers have nail art can you consider the task complete. If ANY finger is missing nail art, you MUST go back and add it. This check is MANDATORY.
10. REMINDER - REPEAT CHECK: Before finalizing, count the fingers with nail art in your result: Thumb: art present? Index: art present? Middle: art present? Ring: art present? Pinky: art present? If the answer to ANY of these is NO, you have not completed the task. You MUST add nail art to the missing finger(s) before you can finish. The result is only correct when ALL 5 fingers have art.
11. FINAL VISUAL COMPARISON - MANDATORY: Before you consider the task complete, you MUST perform this final check: Look at the reference nail art image (second image). Study it carefully - note the exact colors, the exact glitter type and placement, the exact patterns. Now look at your output. Compare them side by side. Ask yourself: Do the colors match EXACTLY? Does the glitter match EXACTLY? Do the patterns match EXACTLY? If you see ANY differences - even small ones - your output is WRONG. You MUST go back and fix it to match the reference EXACTLY. The output nail art should be visually indistinguishable from the reference nail art. If someone showed you both images and asked which is the reference and which is your output, you should not be able to tell them apart based on the nail art design. Only when your output matches the reference PERFECTLY can you consider the task complete.
12. Output in the highest possible resolution with maximum detail.`

      // Call Gemini API for image generation
      // Images first, then prompt (following the pattern from documentation)
      // Config differs between models - 3 Pro supports more options
      const apiConfig = useFlashModel
        ? {
            // Flash model - simpler config
            responseModalities: ['TEXT', 'IMAGE']
          }
        : {
            // 3 Pro model - full config with temperature and 2K resolution
            temperature: 0.4,
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
              imageSize: '2K'
            }
          }

      const response = await geminiClient.models.generateContent({
        model: modelName,
        contents: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: handImage
            }
          },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: inspoImage
            }
          },
          { text: masterPrompt }
        ],
        config: apiConfig
      })

      // Extract the generated image from the response
      let generatedImageBase64 = null
      let responseText = null

      for (const part of response.candidates[0].content.parts) {
        if (part.text) {
          responseText = part.text
          console.log('Gemini response text:', part.text)
        } else if (part.inlineData) {
          generatedImageBase64 = part.inlineData.data
          console.log('✅ Generated nail try-on image received')
        }
      }

      if (!generatedImageBase64) {
        console.error('No image was generated by Gemini')
        return res.status(500).json({
          success: false,
          error: 'No image was generated. The AI may have declined the request.',
          message: responseText
        })
      }

      // Success - deduct credit SERVER-SIDE (saved to RevenueCat attributes)
      let newCreditsRemaining = creditsRemaining
      
      if (stableId && usage) {
        try {
          if (isDemo) {
            // Mark demo as used (no credit deduction for demo)
            usage.demoUsed = true
            await saveUserUsage(stableId, usage)
            console.log(`✅ Demo used for ${stableId}`)
          } else {
            // Deduct credit from appropriate pool
            if (usage.purchasedCredits > 0 && !usage.isSubscribed) {
              // Use purchased credits first if not subscribed
              usage.purchasedCredits = Math.max(0, usage.purchasedCredits - 1)
            } else {
              // Use subscription credits
              usage.weeklyUsed = (usage.weeklyUsed || 0) + 1
            }
            await saveUserUsage(stableId, usage)
            newCreditsRemaining = getCreditsRemaining(usage)
            console.log(`💳 Credit deducted for ${stableId}, remaining: ${newCreditsRemaining}`)
          }
        } catch (error) {
          console.error('Failed to save credit deduction:', error.message)
          // Still return success - image was generated, credit deduction is best effort
        }
      } else {
        // Legacy mode - just calculate remaining (client handles deduction)
        newCreditsRemaining = creditsRemaining - 1
      }

      res.json({
        success: true,
        imageBase64: generatedImageBase64,
        creditsRemaining: newCreditsRemaining,
        message: responseText
      })
    } catch (error) {
      console.error('Gemini API error:', error.message || error)

      // Check for quota/rate limit errors
      if (error.status === 429 || (error.message && error.message.includes('429'))) {
        return res.status(429).json({
          success: false,
          error: 'Service is temporarily busy. Please try again in a minute.'
        })
      }

      // Check for specific Gemini errors
      if (error.message && error.message.includes('SAFETY')) {
        return res.status(400).json({
          success: false,
          error: 'The image was blocked by safety filters. Please try different images.'
        })
      }

      res.status(500).json({
        success: false,
        error: 'Failed to generate nail try-on image',
        details: error.message
      })
    }
  } catch (error) {
    console.error('Nail try-on endpoint error:', error)
    res.status(500).json({
      success: false,
      error: 'Request failed',
      details: error.message
    })
  }
})

// Instagram Media Extraction Endpoint
// Uses HikerAPI to get full-resolution Instagram images
// Expects: { url: String (Instagram post URL) }
// Returns: { success: Boolean, images: [{url, width, height}], isCarousel: Boolean }
// For single images, also returns imageUrl/width/height for backwards compatibility
app.post('/instagram-media', async (req, res) => {
  try {
    const { url } = req.body

    if (!url) {
      return res.status(400).json({ success: false, error: 'Missing "url" in request body' })
    }

    // Validate it's an Instagram URL
    if (!url.includes('instagram.com')) {
      return res.status(400).json({ success: false, error: 'Invalid Instagram URL' })
    }

    if (!HIKERAPI_ACCESS_KEY) {
      console.error('HikerAPI access key not configured')
      return res.status(503).json({ success: false, error: 'Instagram media service not configured' })
    }

    console.log(`\n📸 Fetching Instagram media for URL: ${url}`)

    try {
      // Call HikerAPI to get media info
      const hikerResponse = await axios.get('https://api.hikerapi.com/v1/media/by/url', {
        params: { url },
        headers: {
          'accept': 'application/json',
          'x-access-key': HIKERAPI_ACCESS_KEY
        }
      })

      const mediaData = hikerResponse.data
      
      // Debug: Log the response structure to understand what HikerAPI returns
      console.log('📦 HikerAPI response keys:', Object.keys(mediaData))
      if (mediaData.carousel_media) {
        console.log('📦 carousel_media count:', mediaData.carousel_media.length)
      }
      if (mediaData.resources) {
        console.log('📦 resources count:', mediaData.resources.length)
      }
      if (mediaData.media_type) {
        console.log('📦 media_type:', mediaData.media_type)
      }

      // Check if this is a carousel post (multiple images)
      // HikerAPI may use 'carousel_media' or 'resources' for carousel items
      const carouselItems = mediaData.carousel_media || mediaData.resources
      if (carouselItems && carouselItems.length > 1) {
        const images = []
        
        for (const item of carouselItems) {
          // Each carousel item can be an image or video
          if (item.image_versions && item.image_versions.length > 0) {
            const bestImage = item.image_versions[0]
            images.push({
              url: bestImage.url,
              width: bestImage.width,
              height: bestImage.height,
              isVideo: false
            })
          } else if (item.video_versions && item.video_versions.length > 0) {
            // For videos in carousel, try to get thumbnail if available
            // Skip videos for now as we want nail images
            console.log('Skipping video in carousel')
          }
        }

        if (images.length > 0) {
          console.log(`✅ Found Instagram carousel with ${images.length} images`)
          return res.json({
            success: true,
            isCarousel: true,
            images: images,
            // For backwards compatibility, also include first image as main
            imageUrl: images[0].url,
            width: images[0].width,
            height: images[0].height
          })
        }
      }

      // Single image post
      if (mediaData.image_versions && mediaData.image_versions.length > 0) {
        const bestImage = mediaData.image_versions[0]
        console.log(`✅ Found Instagram image: ${bestImage.width}x${bestImage.height}`)

        return res.json({
          success: true,
          isCarousel: false,
          images: [{
            url: bestImage.url,
            width: bestImage.width,
            height: bestImage.height,
            isVideo: false
          }],
          // For backwards compatibility
          imageUrl: bestImage.url,
          width: bestImage.width,
          height: bestImage.height
        })
      }

      // Fallback: check for video thumbnail if it's a video/reel
      if (mediaData.video_versions && mediaData.video_versions.length > 0) {
        // For videos, try to get the thumbnail
        if (mediaData.image_versions && mediaData.image_versions.length > 0) {
          const thumbnail = mediaData.image_versions[0]
          return res.json({
            success: true,
            isCarousel: false,
            images: [{
              url: thumbnail.url,
              width: thumbnail.width,
              height: thumbnail.height,
              isVideo: true
            }],
            imageUrl: thumbnail.url,
            width: thumbnail.width,
            height: thumbnail.height,
            isVideoThumbnail: true
          })
        }
      }

      console.log('No image found in HikerAPI response')
      return res.status(404).json({ success: false, error: 'No image found for this Instagram post' })

    } catch (apiError) {
      // Handle specific HikerAPI errors
      if (apiError.response) {
        const status = apiError.response.status
        const errorData = apiError.response.data

        if (status === 404) {
          console.log('Instagram post not found via HikerAPI')
          return res.status(404).json({ success: false, error: 'Instagram post not found' })
        }

        if (status === 429) {
          console.log('HikerAPI rate limit exceeded')
          return res.status(429).json({ success: false, error: 'Service temporarily unavailable, please try again later' })
        }

        console.error('HikerAPI error:', status, errorData)
        return res.status(500).json({ success: false, error: 'Failed to fetch Instagram media' })
      }

      throw apiError
    }

  } catch (error) {
    console.error('Instagram media endpoint error:', error.message || error)
    res.status(500).json({ success: false, error: 'Request failed', details: error.message })
  }
})

// =============================================================================
// FEEDBACK ALERT ENDPOINT
// Receives user feedback and sends alerts to Telegram
// Expects: { rating: Number (1-5), comment: String (optional) }
// =============================================================================
app.post('/feedback-alert', async (req, res) => {
  try {
    const { rating, comment } = req.body

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, error: 'Invalid rating (must be 1-5)' })
    }

    // Check if Telegram is configured
    if (!telegramBotKey || !channelId) {
      console.log('⚠️ Telegram not configured, skipping feedback alert')
      return res.json({ success: true, message: 'Feedback received (Telegram not configured)' })
    }

    // Build the Telegram message
    const starEmoji = '⭐'.repeat(rating)
    const emptyStars = '☆'.repeat(5 - rating)
    
    let ratingLabel
    switch (rating) {
      case 1: ratingLabel = '😞 Poor'; break
      case 2: ratingLabel = '😕 Could be better'; break
      case 3: ratingLabel = '😐 Okay'; break
      case 4: ratingLabel = '😊 Good'; break
      case 5: ratingLabel = '🤩 Amazing'; break
      default: ratingLabel = ''
    }

    let message = `📱 Wicked App Feedback\n\n`
    message += `${starEmoji}${emptyStars} (${rating}/5)\n`
    message += `${ratingLabel}\n`
    
    if (comment && comment.trim()) {
      message += `\n💬 Comment:\n"${comment.trim()}"`
    }
    
    message += `\n\n🕐 ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`

    // Send to Telegram
    sendTelegram(message)

    console.log(`📨 Feedback alert sent: ${rating}/5 stars${comment ? ' with comment' : ''}`)

    res.json({ success: true })
  } catch (error) {
    console.error('Feedback alert endpoint error:', error)
    res.status(500).json({ success: false, error: 'Failed to send feedback alert' })
  }
})

// Authentication endpoint for the mobile apps.
// They send the sercret key.
// If verified, we send back the HMAC key that the app should save to make requests to the other endpoints.
app.get('/auth', (req, res) => {
  const responseData = { value: HMAC_SECRET_KEY }
  res.send(responseData)
  console.log('Authorization request received')
  console.log(`[${new Date().toISOString()}] Request received from ${req.ip} for ${req.originalUrl}`)
})

async function postVisionApi (payload) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }

  try {
    const response = await axios.post(chatUrl, payload, { headers })

    if (response) {
      console.log(`ℹ️ Remaing requests for API KEY: ${response.headers['x-ratelimit-remaining-requests']}`)
      console.log(`⏰ Remaing time until rate limit resets for API KEY: ${response.headers['x-ratelimit-reset-requests']}`)

      // Use the commented code to send alerts over Telegram when the API rate limit exceeded.

      // if (response.headers['x-ratelimit-remaining-requests']) {
      //   const remainingRequests = response.headers['x-ratelimit-remaining-requests']
      //   let telegramMessage

      //   if (remainingRequests === 0) {
      //     telegramMessage = `🚨 ALERT: OpenAI API Key doesn't have enough requests available.`
      //     sendTelegram(telegramMessage)
      //   } else if (remainingRequests === 10) {
      //     telegramMessage = `☣️ WARNING: OpenAI API Key has ${remainingRequests} remaining requests.`
      //     sendTelegram(telegramMessage)
      //   }
      // }
    }

    const body = response.data

    try {
      console.log(body)
      console.log(`Image result received and consumed total tokens: ${body.usage.total_tokens}`)
    } catch (error) {
      console.log('The JSON response does not contain total_tokens property. Another response?')
      // If it is not a proper response, check if it is an error response like this
      // {
      // error: {
      //   message: 'Your input image may contain content that is not allowed by our safety system.',
      //   type: 'invalid_request_error',
      //   param: null,
      //   code: 'content_policy_violation'
      // }
      // }

      try {
        if (body.error) {
          console.log('Error response from OpenAI API: ', body.error.message)
          const errorCode = body.error.code
          console.log('With code: ', errorCode)

          throw new Error(errorCode)
        } else {
          throw new Error(body)
        }
      } catch (err) {
        console.error('Error accessing properties of error object from OpenAI API: ', err)
        throw err
      }
    }

    try {
      const parsedMarkDownString = removeMarkdownJsonSyntax(body.choices[0].message.content)
      const jsonResponse = JSON.parse(parsedMarkDownString)
      console.log(jsonResponse)
      return jsonResponse
    } catch (e) {
      console.log(body)

      try {
        console.log(body.choices[0])
      } catch {
        console.log('There is no choices property in the object response from OpenAI')
      }
      console.error('Error parsing JSON:', e)
      throw e
    }
  } catch (error) {
    if (error.response) {
      const body = error.response.data
      try {
        if (body.error) {
          console.log('Error response from OpenAI API: ', body.error.message)
          const errorCode = body.error.code
          console.log('With code: ', errorCode)
          throw new Error(errorCode)
        } else {
          throw new Error(body)
        }
      } catch (err) {
        console.error('Error accessing properties of error object from OpenAI API: ', err)
        throw err
      }
    }
    console.error('Error:', error)
    throw error
  }
}

async function postChatgptApi (payload) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }

  try {
    const response = await axios.post(chatUrl, payload, { headers })

    if (response) {
      console.log(`ℹ️ Remaing requests for API KEY: ${response.headers['x-ratelimit-remaining-requests']}`)
      console.log(`⏰ Remaing time until rate limit resets for API KEY: ${response.headers['x-ratelimit-reset-requests']}`)

      // Use the commented code to send alerts over Telegram when the API rate limit exceeded.

      // if (response.headers['x-ratelimit-remaining-requests']) {
      //   const remainingRequests = response.headers['x-ratelimit-remaining-requests']
      //   let telegramMessage

      //   if (remainingRequests === 0) {
      //     telegramMessage = `🚨 ALERT: OpenAI API Key doesn't have enough requests available.`
      //     sendTelegram(telegramMessage)
      //   } else if (remainingRequests === 10) {
      //     telegramMessage = `☣️ WARNING: OpenAI API Key has ${remainingRequests} remaining requests.`
      //     sendTelegram(telegramMessage)
      //   }
      // }
    }

    const body = response.data

    try {
      // Uncomment for debug API response
      // console.log(body)
      console.log(`ChatGPT response received and consumed total tokens: ${body.usage.total_tokens}`)
    } catch (error) {
      console.log('The JSON response does not contain total_tokens property. Another response?')
      // If it is not a proper response, check if it is an error response like this
      // {
      // error: {
      //   message: 'Your input image may contain content that is not allowed by our safety system.',
      //   type: 'invalid_request_error',
      //   param: null,
      //   code: 'content_policy_violation'
      // }
      // }

      try {
        if (body.error) {
          console.log('Error response from OpenAI API: ', body.error.message)
          const errorCode = body.error.code
          console.log('With code: ', errorCode)

          throw new Error(errorCode)
        } else {
          throw new Error(body)
        }
      } catch (err) {
        console.error('Error accessing properties of error object from OpenAI API: ', err)
        throw err
      }
    }

    try {
      const chatgptResponse = {
        message: body.choices[0].message.content
      }
      console.log(chatgptResponse)
      return chatgptResponse
    } catch (e) {
      console.log(body)

      try {
        console.log(body.choices[0])
      } catch {
        console.log('There is no choices property in the object response from OpenAI')
      }
      console.error('Error parsing JSON:', e)
      throw e
    }
  } catch (error) {
    if (error.response) {
      const body = error.response.data
      try {
        if (body.error) {
          console.log('Error response from OpenAI API: ', body.error.message)
          const errorCode = body.error.code
          console.log('With code: ', errorCode)
          throw new Error(errorCode)
        } else {
          throw new Error(body)
        }
      } catch (err) {
        console.error('Error accessing properties of error object from OpenAI API: ', err)
        throw err
      }
    }
    console.error('Error:', error)
    throw error
  }
}

async function postDalleApi (payload) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }

  try {
    const response = await axios.post(dalleUrl, payload, { headers })
    const body = response.data

    try {
      if (body.error) {
        console.log('Error response from OpenAI API: ', body.error.message)
        const errorCode = body.error.code
        console.log('With code: ', errorCode)

        throw new Error(errorCode)
      }
    } catch (error) {
      console.error('Error accessing properties of error object from OpenAI API: ', error)
      throw error
    }

    try {
      const dalleResponse = {
        imageUrl: body.data[0].url
      }
      console.log(dalleResponse)
      return dalleResponse
    } catch (e) {
      console.log(body)
      throw e
    }
  } catch (error) {
    if (error.response) {
      const body = error.response.data
      try {
        if (body.error) {
          console.log('Error response from OpenAI API: ', body.error.message)
          const errorCode = body.error.code
          console.log('With code: ', errorCode)
          throw new Error(errorCode)
        }
      } catch (err) {
        console.error('Error accessing properties of error object from OpenAI API: ', err)
        throw err
      }
    }
    console.error('Error:', error)
    throw error
  }
}

async function postGptImageApi (payload) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }

  try {
    const response = await axios.post(dalleUrl, payload, { headers })
    const body = response.data

    try {
      if (body.error) {
        console.log('Error response from OpenAI API: ', body.error.message)
        const errorCode = body.error.code
        console.log('With code: ', errorCode)

        throw new Error(errorCode)
      }
    } catch (error) {
      console.error('Error accessing properties of error object from OpenAI API: ', error)
      throw error
    }

    try {
      const imageResponse = {
        imageBase64: body.data[0].b64_json
      }
      console.log(imageResponse)
      return imageResponse
    } catch (e) {
      console.log(body)
      throw e
    }
  } catch (error) {
    if (error.response) {
      const body = error.response.data
      try {
        if (body.error) {
          console.log('Error response from OpenAI API: ', body.error.message)
          const errorCode = body.error.code
          console.log('With code: ', errorCode)
          throw new Error(errorCode)
        }
      } catch (err) {
        console.error('Error accessing properties of error object from OpenAI API: ', err)
        throw err
      }
    }
    console.error('Error:', error)
    throw error
  }
}

// ANTHROPIC CLAUDE
// Anthropic use the same endpoint both messages or vision
// This endpoint expects:
// If it receives a JSON with an image property
// {image: String}
// it will use Vision capabilities.
// If it receives a JSON with a prompt property
// {prompt: String}
// it will use messages capabilities.
// You can change it or add more properties to handle your special cases.

app.post('/anthropic-messages', async (req, res) => {
  try {
    let messages
    // Change here for whatever Anthropic's model you wan to use
    const model = 'claude-3-5-sonnet-20240620'

    if (req.body.prompt) {
      // CHAT
      console.log(`\n💬 Requesting ANTHROPIC MESSAGE prompt: ${req.body.prompt}`)
      messages = [{ role: 'user', content: req.body.prompt }]
    } else if (req.body.image && req.body.language) {
      // VISION
      const prompt = buildWrapFastPrompt(req.body)
      console.log(`\n📸 Requesting image analysis to ANTHROPIC with prompt: ${prompt}`)
      messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: req.body.image
              }
            }
          ]
        }
      ]
    } else {
      return res.status(400).json({ error: 'Invalid request body' })
    }

    try {
      const response = await axios.post(
        anthropicMessagesUrl,
        {
          model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          messages
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          }
        }
      )

      const body = response.data
      const claudeResponse = body.content[0].text

      if (req.body.prompt) {
        console.log(claudeResponse)
        res.json({ message: claudeResponse })
      } else {
        try {
          const jsonResponse = JSON.parse(claudeResponse)
          console.log(jsonResponse)
          res.json(jsonResponse)
        } catch (e) {
          console.log(body)
          console.error('Error parsing JSON:', e)
          res.status(500).json({ error: 'An error occurred while parsing Anthropic response' })
        }
      }
    } catch (error) {
      if (error.response) {
        console.error('Anthropic API returned non-200 status:', error.response.data)
        return res.status(error.response.status).json({ error: 'Error from Anthropic API' })
      }
      console.error('Error calling Anthropic API:', error)
      return res.status(500).json({ error: 'An error occurred while processing your request' })
    }
  } catch (error) {
    console.error('Error calling Anthropic API:', error.response?.data || error.message)
    res.status(500).json({ error: 'An error occurred while processing your request' })
  }
})

// Send from the app a JSON with the properties you need. In this example we send:
// {image: String,
// language: String}
// -Image: to send to the Vision endpoint.
// -Language: to pass the parameter to the prompt and ask GPT answer in that language, configured in the app.
function buildWrapFastPrompt (body) {
  return `Based on the photo of a meal provided, analyze it as if you were a nutritionist and calculate the total calories, calories per 100 grams, carbs, proteins and fats. Name the meal in ${body.language}. Please, always return only a JSON object with the following properties: 'name', 'total_calories_estimation': INT, 'calories_100_grams': INT, 'carbs': INT, 'proteins': INT, 'fats': INT.`
}

// Build the nail try-on prompt for Gemini
function buildNailTryOnPrompt () {
  return `⚠️⚠️⚠️ CRITICAL: BEFORE YOU START, IDENTIFY ALL FINGERS IN THE FIRST IMAGE. Look at the hand image and identify EVERY finger that is visible: 1) THUMB, 2) INDEX FINGER, 3) MIDDLE FINGER, 4) RING FINGER, 5) PINKY FINGER. Write down which fingers you can see. Then apply nail art to EVERY SINGLE ONE.

⚠️ ABSOLUTE REQUIREMENT - READ THIS FIRST: The final image MUST show nail art on ALL 5 FINGERS. Count them: 1) THUMB, 2) INDEX FINGER, 3) MIDDLE FINGER, 4) RING FINGER, 5) PINKY FINGER. If ANY finger is missing nail art, the result is WRONG and must be rejected. Before you finish, verify: thumb has art? index has art? middle has art? ring has art? pinky has art? ALL 5 MUST HAVE NAIL ART. NO EXCEPTIONS.

⚠️⚠️⚠️ CRITICAL INSTRUCTION FOR NAIL ART REPLICATION: Look at the second image (reference nail art) very carefully. Study every detail: the exact colors, the exact glitter type and placement, the exact patterns, the exact textures. Your output nail art must be a PERFECT VISUAL MATCH to the reference. DO NOT use your artistic judgment. DO NOT make it 'better'. DO NOT adjust anything. Your task is SIMPLE: copy the reference nail art exactly as it appears. If the reference has burgundy, use burgundy. If it has chunky gold glitter, use chunky gold glitter. If it has a specific pattern, copy that exact pattern. The reference image is your ONLY source of truth - copy it exactly, without any modifications or interpretations. Before you finish, you MUST compare your output to the reference and ensure they match EXACTLY. If they don't match, you have failed and must fix it.

STEP-BY-STEP PROCESS (FOLLOW EXACTLY):
Step 1: Look at the first image (hand). Identify ALL visible fingers. List them: thumb, index, middle, ring, pinky.
Step 2: For EACH finger you identified in Step 1, create a DIRECT VISUAL COPY of the nail art from the corresponding finger in the second image. Look at the reference finger, then copy what you see - the exact colors, exact glitter, exact pattern. DO NOT interpret. DO NOT improve. DO NOT adjust. COPY IT DIRECTLY as it appears in the reference image.
Step 3: After applying art, check: Did you apply art to the thumb? YES/NO. If NO, go back and apply it.
Step 4: Check: Did you apply art to the index finger? YES/NO. If NO, go back and apply it.
Step 5: Check: Did you apply art to the middle finger? YES/NO. If NO, go back and apply it.
Step 6: Check: Did you apply art to the ring finger? YES/NO. If NO, go back and apply it.
Step 7: Check: Did you apply art to the pinky finger? YES/NO. If NO, go back and apply it.
Step 8: Only when ALL 5 checks are YES can you finish. If ANY check is NO, you must go back and fix it.

Instructions: Apply the EXACT nail art design from the second image onto the fingernails of the hand in the first image. 

CRITICAL CONSTRAINTS:
1. DO NOT change the hand structure, skin tone, lighting, or shape of the fingers.
2. DO NOT change the background - keep it exactly as it is.
3. ONLY modify the fingernail area - apply the nail art pattern precisely.
4. EXACT VISUAL MATCHING - DIRECT COPY - NO INTERPRETATION: This is THE MOST CRITICAL requirement. Your output nail art must be a DIRECT VISUAL COPY of the reference nail art. Think of yourself as a photocopier - you are copying the visual appearance, not interpreting or recreating it. DO NOT make ANY modifications, adjustments, improvements, simplifications, reinterpretations, or creative changes. DO NOT 'improve' the design. DO NOT 'balance' the elements. DO NOT 'clean up' the pattern. DO NOT make it 'more polished'. Your ONLY job is to copy what you see in the reference. The output nail art must match the reference nail art in EVERY visual aspect: EXACT same colors (if reference is burgundy, use burgundy - not maroon, not red, not dark red - BURGUNDY), EXACT same glitter type and density (if reference has chunky gold glitter, use chunky gold glitter - not fine, not silver, not less dense), EXACT same patterns (if reference has a specific pattern, copy that EXACT pattern), EXACT same textures, EXACT same gradients, EXACT same decorative elements. Before finalizing, compare your output to the reference: do the colors match? does the glitter match? does the pattern match? If ANYTHING looks different, you have made a modification and must fix it. The reference is the TRUTH - copy it exactly. The only adaptation is following nail curvature, but visually the design must be identical.
5. The nail polish must look photorealistic, glossy, and follow the exact curve of each nail.
6. Preserve all shadows, highlights, and lighting on the hand and background.
7. FINGER-TO-FINGER MAPPING - DIRECT VISUAL COPY REQUIRED: For each finger, you must create a DIRECT VISUAL COPY of the corresponding finger in the reference image. If the reference thumb shows specific nail art, your output thumb must show that EXACT same nail art - same colors, same glitter, same pattern, same everything. Match index to index, middle to middle, ring to ring, pinky to pinky. For each finger, look at the reference finger, then look at your output finger - they must look the SAME. DO NOT interpret the design. DO NOT recreate it with 'improvements'. DO NOT adjust anything. COPY IT DIRECTLY. If the reference thumb has burgundy with chunky gold glitter at the tip, your output thumb must have burgundy with chunky gold glitter at the tip - not maroon, not fine glitter, not different placement. The visual appearance must be IDENTICAL. The design follows the nail curvature naturally, but all visual elements (colors, glitter, patterns) must match the reference EXACTLY.
8. MANDATORY COMPLETE COVERAGE - ALL 5 FINGERS REQUIRED - THIS IS NON-NEGOTIABLE: The final image MUST have nail art applied to ALL 5 fingers. There are exactly 5 fingers on a hand: 1) THUMB, 2) INDEX FINGER, 3) MIDDLE FINGER, 4) RING FINGER, 5) PINKY FINGER. EVERY SINGLE ONE OF THESE 5 FINGERS MUST HAVE NAIL ART. If you can see the finger in the image, its nail MUST have art. Even if a finger is partially visible, partially obscured, in the background, or at an angle, you MUST apply nail art to its visible nail surface. DO NOT SKIP ANY FINGER. DO NOT MISS ANY FINGER. Before finalizing, count: thumb ✓, index ✓, middle ✓, ring ✓, pinky ✓. If the count is not 5/5, the result is INCORRECT and you must fix it. This is the MOST IMPORTANT requirement.
9. FINAL VERIFICATION CHECK - MANDATORY BEFORE COMPLETION: Before you consider the image complete, you MUST perform this check: Look at the final image and identify each finger. 1) Find the thumb - does it have nail art? If NO, add it now. 2) Find the index finger - does it have nail art? If NO, add it now. 3) Find the middle finger - does it have nail art? If NO, add it now. 4) Find the ring finger - does it have nail art? If NO, add it now. 5) Find the pinky finger - does it have nail art? If NO, add it now. Only when ALL 5 fingers have nail art can you consider the task complete. If ANY finger is missing nail art, you MUST go back and add it. This check is MANDATORY.
10. REMINDER - REPEAT CHECK: Before finalizing, count the fingers with nail art in your result: Thumb: art present? Index: art present? Middle: art present? Ring: art present? Pinky: art present? If the answer to ANY of these is NO, you have not completed the task. You MUST add nail art to the missing finger(s) before you can finish. The result is only correct when ALL 5 fingers have art.
11. FINAL VISUAL COMPARISON - MANDATORY: Before you consider the task complete, you MUST perform this final check: Look at the reference nail art image (second image). Study it carefully - note the exact colors, the exact glitter type and placement, the exact patterns. Now look at your output. Compare them side by side. Ask yourself: Do the colors match EXACTLY? Does the glitter match EXACTLY? Do the patterns match EXACTLY? If you see ANY differences - even small ones - your output is WRONG. You MUST go back and fix it to match the reference EXACTLY. The output nail art should be visually indistinguishable from the reference nail art. If someone showed you both images and asked which is the reference and which is your output, you should not be able to tell them apart based on the nail art design. Only when your output matches the reference PERFECTLY can you consider the task complete.
12. Output in the highest possible resolution with maximum detail.`
}

function removeMarkdownJsonSyntax (str) {
  return str.replace(/^```json\n?/, '').replace(/```$/, '')
}

function sendTelegram (message) {
  const encodedText = encodeURIComponent(message)
  const telegramUrl = `https://api.telegram.org/bot${telegramBotKey}/sendMessage?chat_id=${channelId}&text=${encodedText}`

  https.get(telegramUrl, (tgRes) => {
    console.log('🕊️ Message sent to Telegram Channel', tgRes.statusCode)
  }).on('error', (e) => {
    console.error(`Error sending message to Telegram: ${e.message}`)
  })
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
