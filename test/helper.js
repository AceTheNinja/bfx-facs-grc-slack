const { EventEmitter } = require('events')

class FacCaller extends EventEmitter {
  constructor (root = __dirname) {
    super()
    this.ctx = { root }
  }
}

module.exports = { FacCaller }
