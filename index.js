/*
 * Copyright 2016 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Bacon = require('baconjs');
const util = require('util')
const _ = require('lodash')
const dgram = require('dgram')

const target_headingM_path = "steering.autopilot.target.headingMagnetic"
const target_headingM_pathV = target_headingM_path + '.value'
const target_headingT_path = "steering.autopilot.target.headingTrue"
const target_headingT_pathV = target_headingT_path + '.value'
const state_path = "steering.autopilot.state"
const state_pathV = state_path + '.value'

const m_hex = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F'
]

module.exports = function(app) {
  var unsubscribe = undefined
  var plugin = {}
  var options
  var udpClient
  var autoTimer
  
  plugin.start = function(props) {
    options = props

    if ( options.udpOutEnabled ) {
      udpClient = dgram.createSocket('udp4')
    }
  };

  plugin.registerWithRouter = function(router) {
    router.post("/command", (req, res) => {
      let err = sendCommand(req.body)
      if ( err ) {
        app.error(err)
        res.status(500).send(err)
      } else {
        res.send("Executed command for plugin " + plugin.id)
      }
    })
  }  
  
  plugin.stop = function() {
    if ( udpClient ) {
      udpClient.close()
    }
    if (unsubscribe) {
      unsubscribe()
    }
    if ( autoTimer ) {
      clearInterval(autoTimer)
    }
  }
  
  plugin.id = "raymarineautopilot"
  plugin.name = "NMEA 0183 Autopilot"
  plugin.description = "Plugin that controls an NMEA 0183 autopilot"

  plugin.schema = {
    title: "NMEA 0183 Autopilot Control",
    type: "object",
    required: [
      "telker"
    ],
    properties: {
      talker: {
        type: "string",
        title: "NMEA0183 Talker",
        default: "MA"
      },
      outputEventEnabled: {
        type: 'boolean',
        title: 'Send the NMEA 0183 sentences via an event',
        default: true
      },
      outputEvent: {
        type: 'string',
        title: 'The event name to send',
        default: 'nmea0183out'
      },
      udpOutEnabled: {
        type: 'boolean',
        title: 'Send the NMEA 0183 sentences via udp',
        default: false
      },
      udpAddress : {
        type: 'string',
        title: 'The UDP Address',
        default: '127.0.0.1'
      },
      udpAddress : {
        type: 'number',
        title: 'The UDP Port',
        default: 10110
      },
    }
  }

  function sendTargetHeading() {
    var currentT = app.getSelfPath(target_headingT_pathV)
    var currentM = app.getSelfPath(target_headingM_pathV)

    if ( !_.isUndefined(currentM) || !_.isUndefined(currentT) ) {
      let degsT = !_.isUndefined(currentT) ? radsToDeg(currentT).toFixed(1) : ''
      let degsM = !_.isUndefined(currentM) ? radsToDeg(currentM).toFixed(1) : ''

      let degs = _.isUndefined(currentM) ? degsT : degsM;
      let type = _.isUndefined(currentM) ? 'T' : 'M'

      let headingT = app.getSelfPath('navigation.headingTrue.value')
      let headingM = app.getSelfPath('navigation.headingMagnetic.value')

      let direction
      if ( !_.isUndefined(degsT) && !_.isUndefined(headingT) ) {
        direction = degsT - headingT < 0 ? 'R' : 'L'
      } else {
        direction = degsM - headingM < 0 ? 'R' : 'L'
      }
      
      send0183(`$${options.talker}APB,A,A,0.0000,${direction},N,V,V,${degs},${type},999,${degs},${type},${degs},${type},A`)
      send0183(`$${options.talker}BOD,${degsT},T,${degsM},M,999`)
      send0183(`$${options.talker}BWC,192339.00,,,,,${degsT},T,${degsM},M,,N,999,A`)
      send0183(`$${options.talker}BWR,192339.00,,,,,${degsT},T,${degsM},M,,N,999,A`)
      send0183(`$${options.talker}HSC,${degsT},T,${degsM},M,C`)
      send0183(`$${options.talker}XTE,A,A,0.0000,${direction},N,A`)

      if( !_.isUndefined(headingT) ) {
        app.handleMessage(plugin.id, {
          updates: [{
            values: [{
              path: target_headingT_path,
              value: currentT
            }]
          }]
        })
      }

      if( !_.isUndefined(headingM) ) {
        app.handleMessage(plugin.id, {
          updates: [{
            values: [{
              path: target_headingM_path,
              value: currentM
            }]
          }]
        })
      }
    }
  }

  function computeChecksum (sentence) {
    // skip the $
    let i = 1
    // init to first character
    let c1 = sentence.charCodeAt(i)
    // process rest of characters, zero delimited
    for (i = 2; i < sentence.length; ++i) {
      c1 = c1 ^ sentence.charCodeAt(i)
    }
    return '*' + toHexString(c1)
  }

  function toHexString (v) {
    let msn = (v >> 4) & 0x0f
    let lsn = (v >> 0) & 0x0f
    return m_hex[msn] + m_hex[lsn]
  }

  function send0183(msg) {
    msg = msg + computeChecksum(msg)

    app.debug('send %s', msg)
    if ( options.outputEventEnabled ) {
      app.emit(options.outputEvent, msg)
    }
    if ( options.udpOutEnabled ) {
      udpClient.send(msg, 0, msg.length, options.udpAddress, options.udpPort, (err, bytes) => {
        if ( err ) {
          app.error(err)
          app.setProviderError(err.message)
        }
      })
    }
  }

  function updateTarget(path, current, ammount) {
    let new_value = radsToDeg(current) + ammount

    if ( new_value < 0 ) {
      new_value = 360 + new_value
    } else if ( new_value > 360 ) {
      new_value = new_value - 360
    }
    
    app.debug(`${path}: ${radsToDeg(current)} new value: ${new_value}`)

    app.handleMessage(plugin.id, {
      updates: [{
        values: [{
          path: path,
          value: degsToRad(new_value)
        }]
      }]
    })
  }

  function changeHeading(command_json)
  {
    var ammount = command_json["value"]
    var state = app.getSelfPath(state_pathV)
    var new_value
    
    app.debug("changeHeading: " + state + " " + ammount)
    if ( state == "auto" )
    {
      var currentT = app.getSelfPath(target_headingT_pathV)
      var currentM = app.getSelfPath(target_headingM_pathV)

      if ( _.isUndefined(currentM) && _.isUndefined(currentT) ) {
        //error
        return
      }

      if ( !_.isUndefined(currentM) ) {
        updateTarget(target_headingM_path, currentM, ammount)
      }

      if ( !_.isUndefined(currentT) ) {
        updateTarget(target_headingT_path, currentT, ammount)
      }
    }
  }

  function setState(command_json)
  {
    var state = command_json["value"]
    app.debug("setState: " + state)

    var currentState = app.getSelfPath(state_pathV)

    if ( _.isUndefined(currentState) ) {
      currentState = 'standby'
    }

    if ( state === 'standby' && currentState === 'auto' ) {
      clearInterval(autoTimer)
      autoTimer = null
      app.handleMessage(plugin.id, {
          updates: [{
            values: [{
              path: state_path,
              value: state
            }]
          }]
      })
    } else if ( state === 'auto' && currentState === 'standby' ) {
      let headingT = app.getSelfPath('navigation.headingTrue.value')
      let headingM = app.getSelfPath('navigation.headingMagnetic.value')

      if ( _.isUndefined(headingT) && ! _.isUndefined(headingM) ) {
        return 'current heading unknown'
      }

      if( !_.isUndefined(headingT) ) {
        app.handleMessage(plugin.id, {
          updates: [{
            values: [{
              path: target_headingT_path,
              value: headingT
            }]
          }]
        })
      }

      if( !_.isUndefined(headingM) ) {
        app.handleMessage(plugin.id, {
          updates: [{
            values: [{
              path: target_headingM_path,
              value: headingM
            }]
          }]
        })
      }

      app.handleMessage(plugin.id, {
          updates: [{
            values: [{
              path: state_path,
              value: state
            }]
          }]
      })
      
      autoTimer = setInterval(sendTargetHeading, 1000)
    } else {
      //error if state is wind or track
      return `${state} not supported`
    }
  }

  function sendCommand(command_json)
  {
    var n2k_msgs = null
    var action = command_json["action"]
    app.debug("command: %j", command_json)
    let err
    if ( action == "setState" )
    {
      err = setState(command_json)
    }
    else if ( action == "changeHeading" )
    {
      err = changeHeading(command_json)
    }
    else if ( action == 'advanceWaypoint' )
    {
      res = "not supported"
    }
    else if ( action == "silenceAlarm" )
    {
      res = "not supported"
    }
    return err
  }

  return plugin;
}

function radsToDeg(radians) {
  return radians * 180 / Math.PI
}

function degsToRad(degrees) {
  return degrees * (Math.PI/180.0);
}


