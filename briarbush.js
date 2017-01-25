#!/usr/bin/env node

var Home       = process.env[ ( process.platform === 'win32' ? 'USERPROFILE' : 'HOME' ) ],
    Package    = require( './package' ),
    Config     = require( Home + '/.brubeck/brubeck.json' ),
    Logger     = require( './logger' ),
    Program    = require( 'commander' ),    
    Mailgun    = require( 'mailgun.js' ),
    Later      = require( 'later' ),        
		Promise    = require( 'bluebird' ),
		Moment     = require( 'moment-timezone' ),
		Cron       = require( 'node-schedule' ),
		//Log        = require( 'winston' ),
		Request    = Promise.promisifyAll( require( 'request' ) );


function parseAdList( val ) {

  return val.split( ',' ).map( Number );
};


Program.version( Package.version )
	.option( '-a, --ads    [ads]',    'Ad IDs seperated by a comma', parseAdList )
	.option( '-e, --email  <string>', 'The email address to send the leads' )
  .option( '-r, --run    <string>', 'Set an alternative cron schedule or use keyword "now" to run immediately.', '0 * * * *' )
  .option( '-d, --dealer <string>', 'Dealer name for ADF payload' )	  
  .parse( process.argv );


var app = {};


app.init = function init() {
	var log, mg; 

	log = Logger;
	mg  = Mailgun.client({
		'username': 'api',
		'key':      Config.mailgun.apiKey
	});

	log.debug( 'Initializing' );

  this.settings          = {};
  this.settings.log      = log;
  this.settings.mail     = mg;
	this.settings.adList   = Program.ads;
	this.settings.email    = Program.email;
	this.settings.dealer   = Program.dealer;
	this.settings.schedule = Program.run;  

	if( 'now' !== Program.run ) {
		var cron     = Later.parse.cron( Program.run );	
		var schedule = Later.schedule( cron ).next( 2 );
		var interval = Moment( schedule[1] ).diff( schedule[0], 'hours', true );

		this.settings.interval = interval;
	}
	else {
		this.settings.interval = 240;
	}

  log.debug( 'Initializiation Complete', {
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

	if( !app.get( 'email' ) ) {

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


app.leadsToObject = function leadsToObject( entry ) {
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


app.leadXMLADFPayload = function leadXMLADFPayload( lead ) {
	var payload, dealer;

	dealer   = app.get( 'dealer' );

  payload  = '<?ADF version "1.0"?>';
	payload += '<?XML version "1.0"?>';
	payload += '<adf>';
	payload +=   '<prospect>';
	payload +=     '<requestdate>'+lead.requestdate+'</requestdate>';
	payload +=     '<vehicle>';
	payload +=       '<year>'+lead.year+'</year>';
	payload +=       '<make>'+lead.make+'</make>';
	payload +=       '<model>'+lead.year+'</model>';
	payload +=     '</vehicle>';
	payload +=     '<customer>';
	payload +=       '<contact>';
	payload +=         '<name part="full">'+lead.full_name+'</name>';
	payload +=         '<phone>'+lead.phone_number+'</phone>';
	payload +=         '<email>'+lead.email+'</email>';			
	payload +=       '</contact>';
	payload +=     '</customer>';
	payload +=     '<vendor>';
	payload +=       '<contact>';
	payload +=         '<name part="full">'+dealer+'</name>';		
	payload +=       '</contact>';
	payload +=     '</vendor>';
	payload +=   '</prospect>';
	payload += '</adf>';

	lead['payload'] = payload;

	return lead;
};


app.sendLead = function sendLead( lead ) {
	var log, email, dealer, mail; 

	log    = app.get( 'log'    ); 
	email  = app.get( 'email'  );
	dealer = app.get( 'dealer' );
	mail   = app.get( 'mail'   );

	log.debug( 'Sending lead', {
		'name': lead.full_name
	});

	return mail.messages.create( Config.mailgun.domain, {
		'from': 'Briar Bush <mailgun@mg.workshopdigital.com>',
		'to':    email,
		'subject': 'FB Lead ' + dealer +' '+ lead.full_name,
		'html': lead.payload
	})
	.then( function( response ) {

		log.debug( 'Lead Sent', {
			'Response': response
		});
	});
};


app.maybeExit = function maybeExit() {
	var log, dealer;

	log    = app.get( 'log' );
	dealer = app.get( 'dealer' );

	log.info( 'Complete', {
		'timestamp': Moment().unix(),
		'dealer':    dealer
	});	

	if( 'now' === app.get( 'schedule' ) ) {

		log.info( 'Exiting Program' );
		process.exit( 0 );
	}
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
	.map( app.leadsToObject )
	.map( app.leadXMLADFPayload )
	.map( app.sendLead )
	.catch( function( e ) {
		log.error( e );
		process.exit( 1 );
	})
	.finally( app.maybeExit );
};


// Go
(function createInstance() {
	var ads, email, dealer, schedule;

	console.log( 'Creating Briar Bush instance' );

	app.init()
	.configCheck()
	.run();
})();



