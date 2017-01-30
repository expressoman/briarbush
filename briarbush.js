#!/usr/bin/env node

/*!
 * Briarbush
 * Copyright(c) 2017 Workshop Digital
 */

var Home       = process.env[ ( process.platform === 'win32' ? 'USERPROFILE' : 'HOME' ) ],
    Package    = require( './package' ),
    Config     = require( Home + '/.brubeck/brubeck.json' ),
    Logger     = require( './logger' ),
    Program    = require( 'commander' ),    
		Mailgun    = require( 'mailgun-js' ),    
		OS         = require( 'os' ),  
    Later      = require( 'later' ),        
		Promise    = require( 'bluebird' ),
		Moment     = require( 'moment-timezone' ),
		Cron       = require( 'node-schedule' ),
		Composer   = require( 'mailcomposer' ),
		Request    = Promise.promisifyAll( require( 'request' ) );

		Promise.config({
		    // Enable warnings
		    warnings: true,
		    // Enable long stack traces
		    longStackTraces: true,
		    // Enable cancellation
		    cancellation: true,
		    // Enable monitoring
		    monitoring: true
		});

function parseAdsList( val ) {
  return val.split( ',' ).map( Number );
};


function parseEmailList( val ) {
  return val.split( ',' );
};


Program.version( Package.version )
	.option( '-a, --ads         [ads]',       'Ad IDs seperated by a comma', parseAdsList )
	.option( '-b, --email-bcc   <string>',    'Blind carbon copy email field', null )		
	.option( '-c, --email-cc    <string>',    'Carbon copy email field.', null )		
  .option( '-d, --dealer      <string>',    'Dealer name for ADF payload' )   	
	.option( '-e, --email-to    [addresses]', 'Array of addresses to send the lead.', parseEmailList )
	.option( '-i, --interval    <int>',       'How far back, in hours, to cehck for leads. Default 24', 24  )	
	.option( '-r, --email-reply <string>',    'Reply-to email address.', null )			
  .option( '-s, --schedule    <string>',    'Set an alternative cron schedule or use keyword "now" to run immediately.', '0 * * * *' )
  .parse( process.argv );


var app = {};


app.init = function init() {
	var email, mailer;

	mailer = Mailgun({
		'domain': Config.mailgun.domain,
		'apiKey':      Config.mailgun.apiKey
	}); 

	email = {
		'to':      Program.emailTo,
		'replyTo': Program.emailReply,
		'cc':      Program.emailCc,
		'bcc':     Program.emailBcc
	};

	Logger.debug( 'Initializing' );

  this.settings                 = {};
  this.settings.log             = Logger;
  this.settings.mailer          = mailer;
	this.settings.email           = email;  
	this.settings.adList          = Program.ads;
	this.settings.dealer          = Program.dealer;
	this.settings.schedule        = Program.schedule;  
	this.settings.vehicleComment  = Program.vehicleComment;
	this.settings.customerComment = Program.customerComment;

	if( 'now' !== Program.schedule ) {
		var cron     = Later.parse.cron( Program.schedule );	
		var schedule = Later.schedule( cron ).next( 2 );
		var interval = Moment( schedule[1] ).diff( schedule[0], 'hours', true );

		this.settings.interval = interval;
	}
	else {
		this.settings.interval = Program.interval;
	}

  Logger.debug( 'Initializiation Complete', {
		'ads':      this.settings.adList   || null,
		'email':    this.settings.email    || null,
		'dealer':   this.settings.dealer   || null,
		'schedule': this.settings.schedule || null,
		'interval': this.settings.interval || null
  });

  return this;
};


app.configCheck = function configCheck() {
	var log = app.get( 'log' );

  log.debug( 'Configuration Check' );

	if( !app.get( 'adList' ) ) {

	  log.warn( 'No Ads To Process' );
	  process.exit( 0 );
	}

	if( !app.get( 'email' ).to ) {

	  log.warn( 'No Email Address Supplied' );
	  process.exit( 0 );
	}

	if( !app.get( 'dealer' ) ) {

	  log.warn( 'No Dealer Info Supplied' );
	  process.exit( 0 );
	}

	return this;
};


app.set = function set( setting, val ) {
  if ( arguments.length === 1 ) {
    // app.get(setting)
    return this.settings[setting];
  }

  // set value
  this.settings[setting] = val;

  return this;
};



app.get = function get( setting ) {

  return this.set( setting );
};


app.enabled = function enabled( setting ) {
  
  return Boolean( this.set( setting ) );
};


app.requestLeads = function requestLeads( id ) {
	var log, interval, begin;

	log      = app.get( 'log' );
	interval = app.get( 'interval' );
	begin    = Moment().subtract( interval, 'hours' ).unix();

	log.debug( 'Fetching Leads', {
		'adId': id
	});

	return Request.getAsync({
	  agentOptions: {
	    securityOptions: 'SSL_OP_NO_SSLv3'
	  },
	  url: 'https://graph.facebook.com/v2.8/'+id+'/leads',
	  qs: {
	    access_token: Config.fb.systemToken,
	    filtering: [
				{ 
					'field':'time_created',
					'operator':'GREATER_THAN',
					'value': begin
				}	    
	    ]
	  }
	});
};


app.parseBody = function parseBody( response ) {
  var log, dealer, data;

  log    = app.get( 'log'    );
  dealer = app.get( 'dealer' );

  try {
    data = JSON.parse( response.body );

    if( data.error ) {

    	log.error( data.error.message, {
    		'dealer': dealer,
    		'type':   data.error.type,
    		'code':   data.error.code,
    		'fbId':   data.error.fbtrace_id
    	});

    	throw new Error( data.error.message );
    }
  }
  catch( e ) {

    throw e;
  }	

  return data;
};


app.concatAdData = function concatAdData( data, requests ) {

	return data.concat( requests.data );
};


app.flattenLead = function flattenLead( entry ) {
	var lead = {};

	try {

		entry.field_data.forEach( function( attr ) {
			lead[ 'id' ]          = entry.id;
			lead[ 'requestdate' ] = entry.created_time;
			lead[ attr.name ]     = attr.values[0];
		});
	}
	catch( e ) {
		throw e;
	}

	return lead;	
};


app.formatVehicleInfo = function formatVehicleInfo( lead ) {
	var separator, vehicle;

	separator = lead.vehicle_info.indexOf( ',' ) ? ',' : ' '; 
	vehicle   = lead.vehicle_info.split( separator, 3 );

	lead[ 'vehicle_year' ]  = vehicle[0] ? vehicle[0].replace(/\s/g,'') : 'Unknown';
	lead[ 'vehicle_make' ]  = vehicle[1] ? vehicle[1].replace(/\s/g,'') : 'Unknown';
	lead[ 'vehicle_model' ] = vehicle[2] ? vehicle[2].replace(/\s/g,'') : 'Unknown';

	return lead;
}


app.adfPayload = function adfPayload( lead ) {
	var log, dealer, payload;

	log    = app.get( 'log' );
	dealer = app.get( 'dealer' );

  payload  = '<?ADF version "1.0"?>';
	payload += '<?XML version "1.0"?>';
	payload += '<adf>';
	payload +=   '<prospect status="new">';
	payload +=     '<id source="facebook">'+lead.id+'</id>';
	payload +=     '<requestdate>'+lead.requestdate+'</requestdate>';
	payload +=     '<vehicle interest="buy" status="used">';
	payload +=       '<year>'+lead.vehicle_year+'</year>';
	payload +=       '<make>'+lead.vehicle_make+'</make>';
	payload +=       '<model>'+lead.vehicle_model+'</model>';

	if( lead.vehicle_comment ) {

		payload += '<comments>'+lead.vehicle_comment+'</comments>';

	}

	payload +=     '</vehicle>';
	payload +=     '<customer>';
	payload +=       '<contact>';
	payload +=         '<name part="full" type="individual">'+lead.full_name+'</name>';
	payload +=         '<phone>Not Provided</phone>';				
	payload +=         '<email>'+lead.email+'</email>';			
	payload +=       '</contact>';

	if( lead.customer_comment ) {

		payload += '<comments>'+lead.customer_comment+'</comments>';

	}

	payload +=     '</customer>';
	payload +=     '<vendor>';
	payload +=       '<contact>';
	payload +=         '<name part="full">'+dealer+'</name>';		
	payload +=       '</contact>';
	payload +=     '</vendor>';
	payload +=     '<provider>';
	payload +=       '<contact>';
	payload +=         '<name part="full" type="business">Workshop Digital</name>';
	payload +=       '</contact>';
	payload +=     '</provider>';	
	payload +=   '</prospect>';
	payload += '</adf>';

	lead[ 'adfPayload' ] = payload;

	log.debug( 'ADF Payload Built' );

	return lead;
};


app.htmlPayload = function htmlPayload( lead ) {
	var log, dealer, html;

	log    = app.get( 'log'    );
	dealer = app.get( 'dealer' );

	html  = '<h1>Hello' +dealer+',</h1>';
	html += '<p>'+lead.full_name+' <'+lead.email+'> has submitted a request via Facebook and has been uploaded to your CRM.</p>';
	html += '<table><thead><tr><th>Make</th><th>Model</th><th>Year</th></tr></thead>';
	html += '<tbody><tr>';
	html += '<td>'+lead.vehicle_make+'</td>';
	html += '<td>'+lead.vehicle_model+'</td>';
	html += '<td>'+lead.vehicle_year+'</td>';
	html += '</tr></table>';

	if( lead.customer_comment ) {

		html += '<h3>Customer Comments</h3>';
		html += '<p>'+lead.customer_comment+'</p>';

	}

	if( lead.vehicle_comment ) {

		html += '<h3>Vehicle Comments</h3>';
		html += '<p>'+lead.vehicle_comment+'</p>';

	}	

	lead[ 'htmlPayload' ] = html;

	log.debug( 'HTML Payload Built' );	

	return lead;
};


app.textPayload = function textPayload( lead ) {
	var log, dealer, text;

	log    = app.get( 'log'    );
	dealer = app.get( 'dealer' );

	text  = 'Hello '+dealer+','+OS.EOL;
	text += lead.full_name+' <'+lead.email+'> has submitted a request via Facebook and has been uploaded to your CRM.'+OS.EOL;
	text += 'Make: ' +lead.vehicle_make+OS.EOL;
	text += 'Model: '+lead.vehicle_model+OS.EOL;
	text += 'Year: ' +lead.vehicle_year+OS.EOL;
	text += OS.EOL;

	if( lead.customer_comment ) {

		text += 'Customer Comments'+OS.EOL;
		text += lead.customer_comment+OS.EOL;
		text += OS.EOL;

	}

	if( lead.vehicle_comment ) {

		text += 'Vehicle Comments'+OS.EOL;
		text += lead.vehicle_comment+OS.EOL;
		text += OS.EOL;

	}	

	lead[ 'textPayload' ] = text;	

	return lead;
};


app.buildMessage = function buildMessage( lead ) {
	var email, dealer, options = {};

	email  = app.get( 'email'  );
	dealer = app.get( 'dealer' );

	options = {
		'from': 'Workshop Digital <mailgun@mg.workshopdigital.com>',		
		'to': email.to,
		'subject': 'FB Lead',
		'text': lead.textPayload,
		'html': lead.htmlPayload,
		'alternatives': [
			{ 
				'contentType': 'application/xml',
				'content': lead.adfPayload 
			}
		]
	};

	if( email.cc ) {
		options[ 'cc' ] = email.cc;
	}

	if( email.bcc ) {
		options[ 'bcc' ] = email.bcc;
	}

	if( email.replyTo ) {
		options[ 'Reply-To' ] = email.replyTo;
	}			

	return Promise.promisifyAll( Composer( options ) )
	.buildAsync()
	.then( function( message ) {
		return {
			'to': email.to,
			'from': 'Workshop Digital <mailgun@mg.workshopdigital.com>',
			'message': message.toString( 'ascii' )
		};
	});
}


app.sendLead = function sendLead( message ) {
	var log, email, dealer, mail, options; 

	log     = app.get( 'log'    ); 
	email   = app.get( 'email'  );
	dealer  = app.get( 'dealer' );
	mail    = app.get( 'mailer' );
	
	options = {
		'headers': 
			{
				'content-type': 'multipart/form-data'
			}
	};
	// log.debug( 'Sending lead', {
	// 	'name': lead.full_name
	// });

	return mail.messages().sendMime( message, function( err, body ) {
		Logger.debug( body );

	});
};


app.done = function maybeExit() {
	var log, dealer;

	log    = app.get( 'log' );
	dealer = app.get( 'dealer' );

	log.info( 'Complete', {
		'timestamp': Moment().unix(),
		'dealer':    dealer
	});	
};


app.leadCount = function leadCount( data ) {
	var log = app.get( 'log' );

	log.info( 'Found %s lead(s)', data.length );
};


app.run = function run() {
	var log, dealer, adIds;

	log    = app.get( 'log'    );
	dealer = app.get( 'dealer' );
	adIds  = app.get( 'adList' );

	Promise.map( adIds, app.requestLeads )
	.map( app.parseBody )
	.reduce( app.concatAdData, [] )
	.tap( app.leadCount )
	.map( app.flattenLead )
	.map( app.formatVehicleInfo )
	.map( app.adfPayload )
	.map( app.htmlPayload )
	.map( app.textPayload )
	.map( app.buildMessage )
	.map( app.sendLead )
	.catch( function( e ) {
		log.error( e );
		process.exit( 1 );
	})
	.finally( app.done );
};



// Go
(function createInstance() {
	var ads, email, dealer, schedule;

	console.log( 'Creating Briar Bush Instance' );

	app.init()
	.configCheck();

	return 'now' === app.get( 'schedule' ) ? app.run() : Cron.scheduleJob(app.get('schedule'), app.run);
})();


