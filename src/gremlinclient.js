/*jslint -W079 */
/*jslint node: true */
'use strict';
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var Stream = require('stream').Stream;

var WebSocket = require('ws');
var Guid = require('guid');


function GremlinClient(port, host, session) {
  this.port = port || 8182;
  this.host = host || 'localhost';

  if (session === undefined) 
    this.useSession = false;
  else
    this.useSession = session;

  this.sessionId = Guid.create().value;
  this.connected = false;
  this.queue = [];

  this.commands = {};

  // Open websocket connection
  this.ws = new WebSocket('ws://'+ this.host +':'+ this.port);

  this.ws.onopen = this.onOpen.bind(this);

  this.ws.onerror = function(e) {
    console.log("Error:", e);
  };

  this.ws.onmessage = this.onMessage.bind(this);

  this.ws.onclose = this.onClose.bind(this);
}

inherits(GremlinClient, EventEmitter);

GremlinClient.prototype.onMessage = function(data, flags) {
  var message = JSON.parse(data.data || data);
  var command = this.commands[message.requestId];

  if (message.type === 0) {
    message.result = command.result;
    delete this.commands[message.requestId];
    return command.onEnd(message);
  }

  if (message.type === 1) {
    command.onData(message);
  }
};

GremlinClient.prototype.onOpen = function() {
  this.connected = true;
  this.emit('connect');

  this.executeQueue();
};

GremlinClient.prototype.onClose = function(code) {
  this.terminateCommands({
    message: 'WebSocket closed',
    details: code
  });
};

GremlinClient.prototype.executeQueue = function() {
  var command;

  while (this.queue.length > 0) {
    command = this.queue.shift();
    this.sendMessage(command);
  }
};

GremlinClient.prototype.terminateCommands = function(reason) {
  var commands = this.commands;
  var command;
  var error = new Error(reason.message);
  error.details = reason.details;

  // Empty queue
  this.queue.length = 0;
  this.commands = {};

  Object.keys(commands).forEach(function(key) {
    command = commands[key];
    command.terminate(error);
  });
};

GremlinClient.prototype.buildCommand = function(script, handlers) {
  var guid = Guid.create().value;
  var command = {
    message: {
      requestId: guid,
      processor: "",
      op: "eval",
      args: {
        gremlin: script,
        accept: "application/json",
	session: ""
      }
    },
    onData: handlers.onData,
    onEnd: handlers.onEnd,
    terminate: handlers.terminate,
    result: []
  };

  if(this.useSession) {
    command.message.processor = "session";
    command.message.args.session = this.sessionId;
  }

  return command;
};

GremlinClient.prototype.sendMessage = function(command) {
  this.ws.send(JSON.stringify(command.message));
};

GremlinClient.prototype.execute = function(script, callback) {
  var command = this.buildCommand(script, {
    script: script,
    onData: function(message) {
      this.result = this.result.concat(message.result);
    },
    onEnd: function(data) {
      return callback(null, data);
    },
    terminate: function(error) {
      return callback(error);
    }
  });

  this.sendOrEnqueueCommand(command);
};

GremlinClient.prototype.stream = function(script) {
  var stream = new Stream();

  var command = this.buildCommand(script, {
    script: script,
    onData: function(data) {
      stream.emit('data', data);
      stream.emit('result', data.result, data);
    },
    onEnd: function(data) {
      stream.emit('end', data);
    },
    terminate: function(error) {
      stream.emit('error', error);
    }
  });

  this.sendOrEnqueueCommand(command);

  return stream;
};

GremlinClient.prototype.sendOrEnqueueCommand = function(command) {
  if (this.connected) {
    this.sendMessage(command);
  } else {
    this.commands[command.message.requestId] = command;
    this.queue.push(command);
  }
};

module.exports = GremlinClient;
