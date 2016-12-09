var Home       = process.env[ ( process.platform === 'win32' ? 'USERPROFILE' : 'HOME' ) ],
    Config     = require( Home + '/.brubeck/brubeck.json' ),
		Promise    = require( 'bluebird' ),
		Moment     = require( 'moment-timezone' ),
		Cron       = require( 'node-schedule' ),
		Log        = require( 'winston' ),
		Nodemailer = require('nodemailer');
		Request    = Promise.promisifyAll( require( 'request' ) );


var adIds = [ 6051730587014 ];
var emailAddress = '';		


function requestLeads( id ) {
	var begin = Moment().subtract( 2, 'days' ).unix();

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
}


function parseBody( response ) {
  var data;

  try {
    data = JSON.parse( response.body );
  }
  catch( e ) {
    throw e;
  }	

  return data;
}


function concatAdData( data, requests ) {

	return data.concat( requests.data );
}


function leadsToObj( entry ) {
	var lead = {};

	try {

		entry.field_data.forEach( function( attr ) {
			lead[ 'id' ]          = entry.id;
			lead[ 'requestdate' ] = entry.created_time;
			lead[ attr.name ]     = attr.values[0];
		});

		return lead;
	}
	catch( e ) {
		throw e;
	}
}


function leadXMLADFPayload( lead ) {
	var payload  = '<?ADF version "1.0"?>';
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
			payload +=         '<name part="full">Whitten Brothers CDJR</name>';		
			payload +=       '</contact>';
			payload +=     '</vendor>';
			payload +=   '</prospect>';
			payload += '</adf>';

	return payload;
}


function sendLead( lead ) {
	var transporter = Nodemailer.createTransport( 'smtps://' ),
			options = {
        'from':    'Bluerondo <matthewrussellrosenberg@gmail.com>', // sender address
        'to':      'kelly@workshopdigital.com', // list of receivers
        'subject': 'Whitten Facebook Lead', // ISO time busts INBOX's cache
        'html':    lead
      };

	return new Promise( function( resolve, reject ) {

	  return transporter.sendMail( options, function planNormalQueryLogsMailSend(err, info){
	    if (err) {
	      return reject(err);
	    }

	    return resolve();
	  });
	});
}


Promise.map( adIds, requestLeads )
.map( parseBody )
.reduce( concatAdData, [] )
.map( leadsToObj )
.map( leadXMLADFPayload )
.map( sendLead )
.finally( function() {
	console.log( 'done' );
})
.catch( function( e ) {
	console.log( e );
})

