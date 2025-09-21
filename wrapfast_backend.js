const express = require('express')
const rateLimit = require('express-rate-limit')
const crypto = require('crypto')
const axios = require('axios')
const OpenAI = require('openai')
require('path')
require('assert')
const https = require('https')
require('dotenv').config()
const app = express()

// Change the port if you need it.
const port = 10000

const chatUrl = 'https://api.openai.com/v1/chat/completions'
const dalleUrl = 'https://api.openai.com/v1/images/generations'
const anthropicMessagesUrl = 'https://api.anthropic.com/v1/messages'
const rateLimitErrorCode = 'rate_limit_exceeded'
const wrapFastAppIdentifier = 'wrapfast'

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.API_KEY })

// Environment variables
const apiKey = process.env.API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const AUTH_SECRET_KEY = process.env.AUTH_SECRET_KEY
const HMAC_SECRET_KEY = process.env.HMAC_SECRET_KEY
const AUTH_LIMIT = process.env.AUTH_LIMIT
const PROMPT_LIMIT = process.env.PROMPT_LIMIT
const VISION_MAX_TOKENS = parseInt(process.env.VISION_MAX_TOKENS, 10)
const ANTHROPIC_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10)
const telegramBotKey = process.env.TELEGRAM_BOT_KEY
const channelId = process.env.TELEGRAM_CHANNEL_ID

if (!apiKey || !ANTHROPIC_API_KEY) {
  console.error('API key not found')
  process.exit(1)
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

// GET endpoint to send de hmac secret key
app.use('/auth', authtLimiter)

// Enable Trust Proxy in Express
app.set('trust proxy', true)

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
