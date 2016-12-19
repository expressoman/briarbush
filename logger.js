var winston = require( 'winston' ),
    fs      = require( 'fs' );



function init() {

  winston.setLevels( winston.config.npm.levels );
  winston.addColors( winston.config.npm.colors );

  if ( !fs.existsSync( './log' ) ) {
    fs.mkdirSync( './log' );
  }  

  return new( winston.Logger ) ({
    'exitOnError': true,
    'transports': [
      new winston.transports.Console({
        'level':       'debug',
        'prettyPrint': true,
        'colorize':    true
      }),
      new winston.transports.File({
        'datePattern': 'yyyy-MM-dd',
        'level':       'error',
        'filename':    './log/errors.log',
        'json':        true
      })
    ],
    exceptionHandlers: [
      new winston.transports.Console({
        'prettyPrint': true,
        'colorize':    true
      }),
      new winston.transports.File({
        'datePattern': 'yyyy-MM-dd',
        'filename':    './log/exceptions.log'
      })
    ]
  });
}


function instance() {
  var instance;

  if( !instance ) {
    instance = new init();
  }

  return instance;
}






module.exports = instance();
