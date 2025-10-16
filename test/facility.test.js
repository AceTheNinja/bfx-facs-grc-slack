/* eslint-env jest */

'use strict'

const LRU = require('bfx-facs-lru')

const { FacCaller } = require('./helper')

const GrcSlack = require('../index.js')

describe('GrcSlack Batch Error Logging', () => {
  let grcSlack
  let mockConf
  let lru

  const facCaller = new FacCaller(__dirname)

  beforeAll(async () => {
    lru = new LRU(facCaller, { max: 2048, maxAge: 15000 }, { env: 'test' })

    mockConf = {
      enable: true,
      channel: 'default-channel',
      worker: 'rest:ext:slack',
      max_length: 1024,
      env: 'test',
      errorBatching: {
        interval: 5000,
        maxSize: 10,
        maxMessageLength: 4000
      }
    }

    grcSlack = new GrcSlack(facCaller, { conf: { ...mockConf, errorBatching: { ...mockConf.errorBatching } }, lru }, {})

    await new Promise((resolve, reject) => lru.start((err) => err ? reject(err) : resolve()))
    await new Promise((resolve, reject) => grcSlack.start((err) => err ? reject(err) : resolve()))
  })

  beforeEach(async () => {
    grcSlack._errorBatch.clear()

    if (grcSlack._errorBatchTimer) {
      clearInterval(grcSlack._errorBatchTimer)
      grcSlack._errorBatchTimer = null
    }
  })

  afterEach(() => {
    if (grcSlack && grcSlack._errorBatchTimer) {
      clearInterval(grcSlack._errorBatchTimer)
    }
    jest.clearAllMocks()
  })

  describe('_createErrorKey', () => {
    it('should create unique error keys for different function names', () => {
      const err1 = new Error('Test error')
      const err2 = new Error('Test error')

      const key1 = grcSlack._createErrorKey('channel1', err1, 'function1')
      const key2 = grcSlack._createErrorKey('channel2', err2, 'function2')

      expect(key1).not.toBe(key2)
      expect(key1).toContain('function1')
      expect(key2).toContain('function2')
    })

    it('should create same key for same error and function', () => {
      const err = new Error('Test error')

      const key1 = grcSlack._createErrorKey('channel', err, 'function1')
      const key2 = grcSlack._createErrorKey('channel', err, 'function1')

      expect(key1).toBe(key2)
    })

    it('should handle errors without message', () => {
      const err = {}
      const key = grcSlack._createErrorKey('channel', err, 'function1')

      expect(key).toContain('Unknown error')
      expect(key).toContain('function1')
    })
  })

  describe('_getTimeRange', () => {
    it('should format single timestamp correctly', () => {
      const now = new Date()
      const errors = [{
        firstSeen: now,
        lastSeen: now
      }]

      const timeRange = grcSlack._getTimeRange(errors)
      const expected = now.toISOString().substring(11, 19)

      expect(timeRange).toBe(expected)
    })

    it('should format time range correctly', () => {
      const start = new Date('2023-01-01T10:00:00Z')
      const end = new Date('2023-01-01T10:05:30Z')

      const errors = [{
        firstSeen: start,
        lastSeen: end
      }]

      const timeRange = grcSlack._getTimeRange(errors)

      expect(timeRange).toBe('10:00:00 - 10:05:30')
    })

    it('should handle multiple error entries', () => {
      const start1 = new Date('2023-01-01T10:00:00Z')
      const end1 = new Date('2023-01-01T10:02:00Z')
      const start2 = new Date('2023-01-01T10:01:00Z')
      const end2 = new Date('2023-01-01T10:05:00Z')

      const errors = [
        { firstSeen: start1, lastSeen: end1 },
        { firstSeen: start2, lastSeen: end2 }
      ]

      const timeRange = grcSlack._getTimeRange(errors)

      expect(timeRange).toBe('10:00:00 - 10:05:00')
    })
  })

  describe('logErrorEnqueue', () => {
    it('should create new error entry for first occurrence', async () => {
      const err = new Error('Test error')
      const payload = { to: 'test@example.com', type: 'notification' }

      await grcSlack.logErrorEnqueue('test-channel', err, 'testFunction', payload)

      expect(grcSlack._errorBatch.cache.length).toBe(1)

      const entries = Object.values(grcSlack._errorBatch.cache.cache)
      const entry = entries[0].value

      expect(entry.errorMessage).toBe('Test error')
      expect(entry.sourceName).toBe('testFunction')
      expect(entry.reqChannel).toBe('test-channel')
      expect(entry.count).toBe(1)
      expect(entry.payloads.length).toBe(2) // Initial + added payload
    })

    it('should capture extras alongside payloads', async () => {
      const err = new Error('Test error with extras')
      const payload = { id: 123 }
      const extra1 = 'context-info'
      const extra2 = { meta: true }

      await grcSlack.logErrorEnqueue('chan', err, 'src', payload, extra1, extra2)

      const entries = Object.values(grcSlack._errorBatch.cache.cache)
      const entry = entries[0].value

      expect(entry.payloads.length).toBe(2)
      expect(Array.isArray(entry.payloads[0].extras)).toBe(true)
      expect(Array.isArray(entry.payloads[1].extras)).toBe(true)
      expect(entry.payloads[0].extras.length).toBe(2)
      expect(entry.payloads[1].extras.length).toBe(2)
    })

    it('should increment count for duplicate errors', async () => {
      const err = new Error('Test error')
      const payload1 = { to: 'test1@example.com', type: 'notification' }
      const payload2 = { to: 'test2@example.com', type: 'notification' }

      await grcSlack.logErrorEnqueue('test-channel', err, 'testFunction', payload1)
      await grcSlack.logErrorEnqueue('test-channel', err, 'testFunction', payload2)

      expect(grcSlack._errorBatch.cache.length).toBe(1)

      const entries = Object.values(grcSlack._errorBatch.cache.cache)
      const entry = entries[0].value

      expect(entry.count).toBe(2)
      expect(entry.payloads.length).toBe(3) // Initial + 2 added payloads
    })

    it('should fall back to direct logging on error', async () => {
      const logErrorSpy = jest.spyOn(grcSlack, 'logError').mockResolvedValue(undefined)

      const originalCreateErrorKey = grcSlack._createErrorKey
      grcSlack._createErrorKey = jest.fn(() => { throw new Error('Test error') })

      const err = new Error('Test error')
      const payload = { to: 'test@example.com' }

      await grcSlack.logErrorEnqueue('test', err, 'testFunc', payload)

      expect(logErrorSpy).toHaveBeenCalledTimes(1)

      grcSlack._createErrorKey = originalCreateErrorKey
      
      logErrorSpy.mockRestore()
    })
  })

  describe('_processBatchedErrors', () => {
    it('should return early if no batched errors', async () => {
      const sendSpy = jest.spyOn(grcSlack, '_sendBatchedErrorMessage').mockResolvedValue(undefined)

      await grcSlack._processBatchedErrors()

      expect(sendSpy).not.toHaveBeenCalled()

      sendSpy.mockRestore()
    })

    it('should group errors by function and channel', async () => {
      const sendSpy = jest.spyOn(grcSlack, '_sendBatchedErrorMessage').mockResolvedValue(undefined)

      const err1 = new Error('Error 1')
      const err2 = new Error('Error 2')

      await grcSlack.logErrorEnqueue('channel1', err1, 'func1', { to: 'test1' })
      await grcSlack.logErrorEnqueue('channel2', err2, 'func1', { to: 'test2' })
      await grcSlack.logErrorEnqueue('channel1', err1, 'func2', { to: 'test3' })

      await grcSlack._processBatchedErrors()

      expect(sendSpy).toHaveBeenCalledTimes(3)

      sendSpy.mockRestore()
    })

    it('should clear batch after processing', async () => {
      jest.spyOn(grcSlack, '_sendBatchedErrorMessage').mockResolvedValue(undefined)

      const err = new Error('Test error')
      await grcSlack.logErrorEnqueue('test', err, 'func1', { to: 'test' })

      expect(grcSlack._errorBatch.cache.length).toBe(1)

      await grcSlack._processBatchedErrors()

      expect(grcSlack._errorBatch.cache.length).toBe(0)
    })

    it('should handle processing errors gracefully and clear batch', async () => {
      const err = new Error('Test error')
      await grcSlack.logErrorEnqueue('test', err, 'func1', { to: 'test' })

      const batchSendSpy = jest.spyOn(grcSlack, '_sendBatchedErrorMessage').mockRejectedValue(new Error('Send error'))

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation()

      await grcSlack._processBatchedErrors()

      expect(consoleSpy).toHaveBeenCalledWith('Failed to process batched errors', expect.any(Error))
      expect(grcSlack._errorBatch.cache.length).toBe(0)

      consoleSpy.mockRestore()
      batchSendSpy.mockRestore()
    })
  })

  describe('_sendBatchedErrorMessage', () => {
    it('should format batch message correctly', async () => {
      const logErrorSpy = jest.spyOn(grcSlack, 'logError').mockResolvedValue(undefined)

      const errors = [
        {
          errorMessage: 'Test error 1',
          count: 3,
          payloads: [
            { payload: { to: 'test1@example.com', type: 'notification' }, extras: ['ex1'] },
            { payload: { to: 'test2@example.com', type: 'alert' }, extras: ['ex2'] }
          ],
          firstSeen: new Date('2023-01-01T10:00:00Z'),
          lastSeen: new Date('2023-01-01T10:05:00Z')
        }
      ]

      await grcSlack._sendBatchedErrorMessage('test-channel', 'testFunction', errors)

      expect(logErrorSpy).toHaveBeenCalledTimes(1)

      const [channel, message] = logErrorSpy.mock.calls[0]
      expect(channel).toBe('test-channel')
      expect(message).toContain('Batched Error Report - testFunction')
      expect(message).toContain('3 errors across 1 types')
      expect(message).toContain('Test error 1')

      logErrorSpy.mockRestore()
    })

    it('should include extras in message when present', async () => {
      const logErrorSpy = jest.spyOn(grcSlack, 'logError').mockResolvedValue(undefined)

      const errors = [
        {
          errorMessage: 'Err with extras',
          count: 1,
          payloads: [
            { payload: { foo: 'bar' }, extras: ['extra-info', { trace: true }] }
          ],
          firstSeen: new Date(),
          lastSeen: new Date()
        }
      ]

      await grcSlack._sendBatchedErrorMessage('ch', 'src', errors)

      const [, message] = logErrorSpy.mock.calls[0]
      expect(String(message)).toContain('Extras:')
      expect(String(message)).toContain('extra-info')

      logErrorSpy.mockRestore()
    })

    it('should truncate long messages', async () => {
      const logErrorSpy = jest.spyOn(grcSlack, 'logError').mockResolvedValue(undefined)

      grcSlack.conf.errorBatching.maxMessageLength = 200

      const errors = [
        {
          errorMessage: 'Test error with very long details that should cause truncation',
          count: 1,
          payloads: [
            {
              payload: {
                to: 'test@example.com',
                type: 'notification',
                data: 'Very long data that will make the message exceed the limit'.repeat(10)
              },
              extras: ['extra1', 'extra2']
            }
          ],
          firstSeen: new Date(),
          lastSeen: new Date()
        }
      ]

      await grcSlack._sendBatchedErrorMessage('test', 'testFunc', errors)

      const [, message] = logErrorSpy.mock.calls[0]
      expect(message).toContain('truncated')

      grcSlack.conf.errorBatching.maxMessageLength = mockConf.errorBatching.maxMessageLength
      logErrorSpy.mockRestore()
    })

    it('should limit number of error types displayed', async () => {
      const logErrorSpy = jest.spyOn(grcSlack, 'logError').mockResolvedValue(undefined)

      const errors = Array.from({ length: 15 }, (_, i) => ({
        errorMessage: `Error ${i}`,
        count: 1,
        payloads: [{ payload: { to: `test${i}@example.com` }, extras: [] }],
        firstSeen: new Date(),
        lastSeen: new Date()
      }))

      await grcSlack._sendBatchedErrorMessage('test', 'testFunc', errors)

      const [, message] = logErrorSpy.mock.calls[0]
      expect(message).toContain('and 5 more error types')

      logErrorSpy.mockRestore()
    })
  })

  describe('Integration Tests', () => {
    it('should handle complete batching workflow', async () => {
      const logErrorSpy = jest.spyOn(grcSlack, 'logError').mockResolvedValue(undefined)

      const err1 = new Error('Database connection failed')
      const err2 = new Error('API timeout')

      await grcSlack.logErrorEnqueue('alerts', err1, 'dbConnect', { user: 'user1' })
      await grcSlack.logErrorEnqueue('alerts', err1, 'dbConnect', { user: 'user2' })
      await grcSlack.logErrorEnqueue('alerts', err2, 'apiCall', { endpoint: '/users' })

      await grcSlack._processBatchedErrors()

      expect(logErrorSpy).toHaveBeenCalledTimes(2)

      const messages = logErrorSpy.mock.calls.map(call => call[1])
      expect(messages.some(msg => String(msg).includes('Database connection failed'))).toBe(true)
      expect(messages.some(msg => String(msg).includes('API timeout'))).toBe(true)

      logErrorSpy.mockRestore()
    })

    it('should handle different channels correctly', async () => {
      const logErrorSpy = jest.spyOn(grcSlack, 'logError').mockResolvedValue(undefined)

      const err = new Error('Test error')

      await grcSlack.logErrorEnqueue('channel1', err, 'func1', { data: 'test1' })
      await grcSlack.logErrorEnqueue('channel2', err, 'func1', { data: 'test2' })

      await grcSlack._processBatchedErrors()

      expect(logErrorSpy).toHaveBeenCalledTimes(2)

      const channels = logErrorSpy.mock.calls.map(call => call[0])
      expect(channels).toContain('channel1')
      expect(channels).toContain('channel2')

      logErrorSpy.mockRestore()
    })

    it('should use conf.channel as fallback when channel is missing', async () => {
      const err = new Error('Test error')
      const payload = { data: 'test' }

      await grcSlack.logErrorEnqueue(null, err, 'func1', payload)
      await grcSlack.logErrorEnqueue(undefined, err, 'func2', payload)
      await grcSlack.logErrorEnqueue('', err, 'func3', payload)

      expect(grcSlack._errorBatch.cache.length).toBe(3)

      const entries = Object.values(grcSlack._errorBatch.cache.cache)
      entries.forEach(({ value: entry }) => {
        expect(entry.reqChannel).toBe('default-channel')
      })
    })

    it('should accept valid channels', async () => {
      const err = new Error('Test error')
      const payload = { data: 'test' }

      // Test with valid string channel
      await expect(grcSlack.logErrorEnqueue('valid-channel', err, 'func1', payload))
        .resolves.not.toThrow()

      // Test with another valid channel format
      await expect(grcSlack.logErrorEnqueue('general', err, 'func2', payload))
        .resolves.not.toThrow()

      // Verify entries were created
      expect(grcSlack._errorBatch.cache.length).toBe(2)
    })
  })

  describe('Timer and Lifecycle Tests', () => {
    it('should initialize error batching timer', () => {
      const instance = new GrcSlack(facCaller, { conf: mockConf, lru }, {})
      expect(instance._errorBatchTimer).toBeTruthy()
      if (instance._errorBatchTimer) {
        clearInterval(instance._errorBatchTimer)
      }
    })

    it('should not initialize batching when errorBatching is absent', () => {
      const confNoBatch = { ...mockConf, errorBatching: undefined }
      const instance = new GrcSlack(facCaller, { conf: confNoBatch, lru }, {})
      expect(instance._errorBatch).toBeUndefined()
      expect(instance._errorBatchTimer).toBeUndefined()
    })

    it('should process final batch during shutdown', async () => {
      const processSpy = jest.spyOn(grcSlack, '_processBatchedErrors').mockResolvedValue(undefined)

      // Add batched errors
      const err = new Error('Test error')
      await grcSlack.logErrorEnqueue('test', err, 'func1', { to: 'test' })

      // Call _stop
      await new Promise((resolve) => {
        grcSlack._stop(resolve)
      })

      expect(processSpy).toHaveBeenCalled()

      processSpy.mockRestore()
    }, 10000)
  })

  describe('Disabled batching behavior', () => {
    it('logErrorEnqueue should fallback to direct log when not initialized', async () => {
      const confNoBatch = { ...mockConf, errorBatching: undefined }
      const instance = new GrcSlack(facCaller, { conf: confNoBatch }, {})
      const spy = jest.spyOn(instance, 'logError').mockResolvedValue(undefined)

      const err = new Error('no batch')
      await instance.logErrorEnqueue('ch', err, 'src', { a: 1 }, 'e1')

      expect(spy).toHaveBeenCalledTimes(1)

      spy.mockRestore()
    })
  })
})
