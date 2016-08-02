var cheerio = cheeriogasify.require('cheerio');
var $ = cheerio;

var version = "5.0.2";
var sendMail = true;

var defaults = {
  debug: false,
  showMap: false,
  mapZoom: 7,
  showTags: false,
  groupedResults: true,
  startIndex: 2,
  dateFormat: {
    human: 'd MMMM, HH:mm',
    iso: 'YYYY-MM-DDTHH:mm:ss.sssZ'
  },
  colors: {
    background: {
      working: '#ECEFF1',
      success: '#DCEDC8'
    },
    border: {
      working: '#B0BEC5'
    }
  },
  names: {
    sheet: {
      main: 'Vos alertes',
      variables: 'Paramètres utilisateur',
      debug: 'debug'
    },
    range: {
      label: 'labelRange',
      url: 'urlRange',
      lastAd: 'lastAdRange',
      userVarNames: 'userVarNamesRange',
      userVarValues: 'userVarValuesRange',
      advancedOptions: 'advancedOptionsRange'
    },
    mail: {
      anchorPrefix: 'part-'
    }
  },
  selectors: {
    adItem: '.mainList ul > li',
    adsContext: '#listingAds'
  }
};

var normalizedData = {
  result: [],
  entities: {},
  update: false
};

// PARAMS global variable
// todo : refactor with https://developers.google.com/apps-script/guides/properties ?
var params;


/**
* Init
*/
function init(userParams) {
  setParams(userParams);
  createMenu();
  checkMainTrigger();
}


/**
  * Create menu
*/
function createMenu() {
  var ui = SpreadsheetApp.getUi();

  // We need to set a local "handle" to call a library function
  ui.createMenu('Alertes LeBonCoin')
      //.addItem('Modifier email destinataire', 'handleUpdateRecipientEmail')
      .addItem('Paramètres utilisateur', 'handleOpenVariablesSheet')
      .addItem('Planification des alertes', 'handleShowMainTriggerWizard')
      .addSeparator()
      .addItem('Lancer manuellement', 'alertesLeBonCoin')
      .addToUi();
}


/**
  * On open variables sheet
*/
function openVariablesSheet(userParams) {
 setParams(userParams);
 SpreadsheetApp.setActiveSheet(getVariablesSheetContext()); 
}


/**
  * Start, everything start from here
*/
function start(userParams) {
  
  setParams(userParams);
  
  if ( !isRecipientEmail() ) {
   return; 
  }

  // For each value in the url range sheet
  forEachCellInRange( params.names.range.url, params.startIndex, function(index) {
    
    var rangeNames = params.names.range;
    var sheetNames = params.names.sheet;
      
    var lastRangeName = params.isAvailable.advancedOptions ? rangeNames.advancedOptions : rangeNames.lastAd;
    var row = getRowByIndex(index, lastRangeName, sheetNames.main);
    
    highlightRow(row);
    
    var url = getCellByIndex( index, rangeNames.url, sheetNames.main ).getValue(); // String URL expected
    var ads = getUrlAds(url);

    if (ads.length && sendMail) {
      
      var latestAdCellValue = getCellByIndex( index, rangeNames.lastAd, sheetNames.main ).getValue(); // Date Object expected
      var latestAds = getLatestAds(ads, latestAdCellValue);
      
      if (latestAds.length) {
        
        var label = getCellByIndex( index, rangeNames.label, sheetNames.main ).getValue(); // String expected
        
        var stringifiedOptions = params.isAvailable.advancedOptions ? getCellByIndex( index, rangeNames.advancedOptions, sheetNames.main ).getValue() : "";
        var options = stringifiedOptions.length ? JSON.parse(stringifiedOptions) : {};
        
        setNormalizedData(index, label, url, latestAds, options);
      }
    }
    
    unhighlightRow(row);

  });
  
  
  var update = checkForUpdates();
  if ( update ) {
    normalizedData.update = update;
  }
  
  
  var data = normalizedData;
  
  // If results, send email
  // TODO : refactor
  if ( data.result.length && sendMail ) {
    
    var recipientEmail = getRecipientEmail();
    
    handleSendData( data, recipientEmail, function(error, result) {

      if (error && error.name == 'Exception') {
        getSpreadsheetContext().toast(error.message, 'Alertes LeBonCoin');
      } else {
        
        getSpreadsheetContext().toast("mail envoyé  à " + recipientEmail, 'Alertes LeBonCoin');
        
        if (params.debug !== true) {
          forEachResult( result, data.entities, setLatestAdRangeValue );  
        } 
        
      }
      
    });
  }
    
}


/**
  * For each result
*/
function forEachResult( result, entities, callback ) {
  
  for (var i = 0; i < result.length; i++ ) {
    var index = result[i];
    
    if (callback && typeof(callback) === "function") {
      callback(index, entities);
    }
    
  }
}



/**
  * --------------------- *
  *  ABOUT PREREQUISITES
  * --------------------- *
*/

/**
  * Set params
*/
function setParams(userScriptParams) {
  
  var scriptParams = deepExtend({}, defaults, handleDepreciatedParams(userScriptParams) );
 
  params = scriptParams; // because getUserParamsFromSheet() need params... (maybe needs to refactor?)
  var sheetParams = getUserParamsFromSheet();
  
  var mergedParams = deepExtend({}, scriptParams, sheetParams)
  params = mergedParams;
}


/**
  * Handle old versions params
*/
function handleDepreciatedParams(userScriptParams) {
  
  var modifiedParams = userScriptParams || {};
  
  var rangeNames = (((userScriptParams || {}).names || {}).range || {});

  // manage deprecated adIdRange
  var adIdRange = rangeNames.adId
  var lastAdRange = rangeNames.lastAd;
  
  if (typeof adIdRange !== 'undefined' && typeof lastAdRange == 'undefined') {
    modifiedParams.names.range.lastAd = userScriptParams.names.range.adId;
    delete modifiedParams.names.range.adId;
  }
  
  modifiedParams.isAvailable = {};
  
  var userVarNamesRange = rangeNames.userVarNames;
  if (typeof userVarNamesRange == 'undefined') {
    modifiedParams.isAvailable.sheetParams = false;
  } else {
    modifiedParams.isAvailable.sheetParams = true;
  }
  
  var advancedOptionsRange = rangeNames.advancedOptions;
  if (typeof advancedOptionsRange == 'undefined') {
    modifiedParams.isAvailable.advancedOptions = false;
  } else {
    modifiedParams.isAvailable.advancedOptions = true;
  }
  
  return modifiedParams;
}


/**
  * Get user params from variables sheet
*/
function getUserParamsFromSheet() {
  
  var sheetUserParams = {};
    
  if (params.isAvailable.sheetParams) {
    forEachCellInRange( params.names.range.userVarNames, params.startIndex, function(index) {
      
      var name = getCellByIndex(index, params.names.range.userVarNames, params.names.sheet.variables).getValue();
      var value = getCellByIndex(index, params.names.range.userVarValues, params.names.sheet.variables).getValue();
      
      sheetUserParams[name] = value;
    });
  }
  
  return sheetUserParams;
}


/**
  * Check main trigger
*/
function checkMainTrigger(callbackString) {
  
  var triggers = ScriptApp.getProjectTriggers();
    
  if (!triggers.length) {
    showMainTriggerWizard(callbackString);
    return false;
  }
  
  return true;
}


/**
  * Set main trigger
*/
function setMainTrigger(hours) {
  
  deleteProjectTriggers();
  var trigger = ScriptApp.newTrigger('alertesLeBonCoin').timeBased().everyHours(hours).create();
  var triggerId = trigger.getUniqueId();
  
  var toastText = "Vos alertes ont été réglées sur \"toutes les " + hours + " heures\"";
  if (triggerId) {
    getSpreadsheetContext().toast(toastText, 'Alertes LeBonCoin');
  }
}


/**
  * Delete project triggers
*/
function deleteProjectTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  
    for (var i = 0; i < triggers.length; i++) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
}


/**
  * Get recipient email
*/
function getRecipientEmail() {
  
  var recipientEmail;
  
  if (params.isAvailable.sheetParams) {
    recipientEmail = params.email;
  } else {
    recipientEmail = getValuesByRangeName( params.names.range.recipientEmail )[1][0];
  }
       
  return recipientEmail;
}


/**
  * Check if recipient email is defined
*/
function isRecipientEmail(callbackString) {
  
  var email = getRecipientEmail();

  if (!email.length) {
    setActiveSelectionOnEmail();
    showDialog("Oups !", "Merci de remplir le champ <strong><em>email</em></strong>");
    return false; 
  }
  
  return true;
}


/**
  * Get recipient email range
*/
function getRecipientEmailCell() {
  var cell = getCellByIndex(2, params.names.range.userVarValues, params.names.sheet.variables);
  //var range = getVariablesSheetContext().getRange( 2, getColumnByName( params.names.range.userVarValues ) );
  return cell;
}


/**
  * Set active selection on email
*/
function setActiveSelectionOnEmail() {
  SpreadsheetApp.setActiveSheet(getVariablesSheetContext());
  getVariablesSheetContext().setActiveSelection( getRecipientEmailCell() );
}


/**
  * Check for updates
*/
function checkForUpdates() {
  
  var update = false;
  var url = "https://raw.githubusercontent.com/maximelebreton/alertes-leboncoin/master/version.json";
  
  try {
    var response = UrlFetchApp.fetch(url);
    var data = JSON.parse(response.getContentText());

    if ( versionCompare( data.version, version ) == 1) {
      
      update = data;
    }
  } catch(e) {
    // handle error
  }
    
  return update;
}




/**
  * --------------------- *
  *  ABOUT SPREADSHEET UI
  * --------------------- *
*/


/**
  * Show main trigger wizard
*/
function showMainTriggerWizard(callbackString) {
  
  var ui = SpreadsheetApp.getUi();
  var template = HtmlService.createTemplateFromFile('mainTriggerWizardTemplate');
      template.callbackString = callbackString;
  
  var html = template.evaluate().setWidth(360).setHeight(120);
  var response = ui.showModelessDialog(html, "Voulez-vous planifier l'envoi des alertes ?");
}


/**
  * Show simple dialol
*/
function showDialog(title, content) {
 var htmlOutput = HtmlService
 .createHtmlOutput('<div style="font: 13px/18px arial, sans-serif;">' + content + '</div>')
     .setWidth(250)
     .setHeight(80);
  SpreadsheetApp.getUi().showModelessDialog(htmlOutput, title); 
}


/**
  * Highlight row
*/
function highlightRow(row) {
  row.setBorder(true, true, true, true, false, false, params.colors.border.working, null);
  row.setBackground( params.colors.background.working );
  SpreadsheetApp.flush(); // see https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet-app#flush
}


/**
  * Unhighlight row
*/
function unhighlightRow(row) {
  row.setBorder(false, false, false, false, false, false);
  row.setBackground('');
  SpreadsheetApp.flush();
}


/**
  * Set latest Ad value
*/
function setLatestAdRangeValue(index, entities) {
  
  var latestAdDate = new Date( entities.ads[index].latest[0].timestamp );
  var adIdRange = getDataSheetContext().getRange( index, getColumnByName( params.names.range.lastAd ) );
  
  adIdRange.setValue( latestAdDate );
  adIdRange.setNumberFormat( params.dateFormat.human );
  adIdRange.setBackground( params.colors.background.success );  
}




/**
  * ---------------- *
  *  ABOUT ADS DATA
  * ---------------- *
*/


/**
  * Get url ads
*/
function getUrlAds(url) {
  
  var listingAds;
  
  var html = getUrlContent( url );
  listingAds = getListingAdsFromHtml( html );
  
  return listingAds;
}


/**
  * Get url content
*/
function getUrlContent(url) {

  return UrlFetchApp.fetch(url).getContentText("iso-8859-15");
}


/**
  * Get listing ads data
  * @returns {Object} Returns data of the listing ads
*/
function getListingAdsFromHtml( html ) {  
  
  var data = [];
  var protocol = 'https:';
  
  var mainHtml = extractMainHtml(html); // get only the needed part, for cheerio performance
  
  /*var start1 = new Date().getTime();
  var end1 = new Date().getTime();
  log( start1 - end1 );*/
  
  var $selector = $(params.selectors.adItem, params.selectors.adContext, mainHtml);
        
  // liste des annonces
  $selector.each(function(i, element) {
    
    // limiter le nombre de résultats
    /*if (params.limitResults) {
      if (i >= params.limitResults) {
        return;
      }
    }*/
    
    var $this = $(this);
    
    var $a = $this.find('a');
    
    var $item_supp = $this.find('.item_supp');
    
    var $title = $this.find('.item_title');
    var $price = $this.find('.item_price');
    var $place = $item_supp.eq( 1 );
    var $img = $this.find('.item_image').find('.lazyload');    
    var $date = $item_supp.eq( 2 );
    var isPro = $this.find('.ispro').length ? true : false;
        
    var item = {
      id: Number($a.data( "info" ).ad_listid),
      title: $title.text().trim(),
      price: $price.text(),
      place: $place.text(),
      date: $date.text(),
      isPro: isPro,
      url: protocol + $a.attr("href"),
      img: {
        src: addProtocol( $img.data("imgsrc") )
      }
      
    };
    
    // A real Date Object with milliseconds based on Ad Id to prevent conflicts
    item.timestamp = getAdDateTime( item.date, item.id ).getTime();
        
    data.push(item);
    
  });
    
  return data;
}


/**
  * Extract main html
*/
function extractMainHtml(html){
  
  var mainStartTag = '<main id="main"';
  var mainEndTag = '</main>';
  
  var from = html.indexOf(mainStartTag) + mainStartTag.length;
  var to = html.indexOf(mainEndTag, from)
  
  var mainHtml = html.substring( from, to );
  
  return mainHtml;
}


/**
  * Get Ad Date Time (with adId param to generate milliseconds)
*/
var getAdDateTime = function(adDateTime, adId) {
  
  // Date is now
  var d = new Date();
  // Reset seconds and milliseconds because of Ad Id magic trick
  d.setSeconds(0);
  d.setMilliseconds(0);
  
  var dateTimeSeparator = adDateTime.indexOf(',');
  var dateString = adDateTime.substring(0, dateTimeSeparator).trim().toLowerCase();
  var timeString = adDateTime.substring(dateTimeSeparator + 1).trim();
  var timeSeparator = timeString.indexOf(":");
  var dateSeparator = dateString.indexOf(" ");
  
  // Month, Day
  var month;
  var day;
  switch( dateString ) {
      case "aujourd'hui":
          var today = d;
          month = today.getMonth();
          day = today.getDate();
          break;
      case "hier":
          var yesterday = new Date( d.setDate(d.getDate() - 1) );
          month = yesterday.getMonth();
          day = yesterday.getDate();
          break;
      default:
          var monthString = dateString.substring(dateSeparator + 1);
          var dayString = dateString.substring(0, dateSeparator);
          month = getMonthNumber( monthString );
          day = Number( dayString );
  }
  
  // Hours, minutes
  var hours = Number(timeString.substring(0, timeSeparator));
  var minutes = Number(timeString.substring(timeSeparator + 1));
  
  // Milliseconds based on Ad Id (magic trick)
  var milliseconds = getMillisecondsByMagic( adId );
  
  d.setMonth( month );
  d.setDate( day );
  d.setHours( hours );
  d.setMinutes( minutes );
  d.setMilliseconds( milliseconds );
  
  var date;
  
  if ( typeof d.getMonth === 'function' ) {
    date = d;
  }
  
  //log(date);
  return date;
}


/**
  * Get month number
*/
function getMonthNumber(month) {
    
  var months = ["jan", "fév", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
  var fullMonths = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  
  var monthNumber = months.indexOf( month );
  var fullMonthNumber = fullMonths.indexOf( month );
  
  var number = (monthNumber >= 0) ? monthNumber : fullMonthNumber;
      
  return number;
}


/**
  * Get last digits
*/
function getLastDigits(number, count) {
  
  var stringNumber = number.toString();
  var length = stringNumber.length;
  var lastDigits = Number( stringNumber.slice(length-count, length) );
  
  return lastDigits;
}


/**
  * Get milliseconds by magic
*/
function getMillisecondsByMagic(id) {

  var secondInMilliseconds = 60000-1;
  var idInMilliseconds = getLastDigits(id,4); // fake, but that's the trick (needs 10000 consecutive ads with same dateTime to fail...)
  var milliseconds = secondInMilliseconds - idInMilliseconds;
  
  return milliseconds;
}


/**
  * Get latest ads (based on stored value)
*/
function getLatestAds(ads, latestAdValue) {
  
  var latestAds = [];
   
  var latestAdStoredTimestamp = null;
  if (typeof latestAdValue.getTime === 'function') {
    latestAdStoredTimestamp = latestAdValue.getTime();
  }
  
  var latestAdTimestamp = ads[0].timestamp;
  
  if (latestAdTimestamp !== latestAdStoredTimestamp) {
    
    if (latestAdStoredTimestamp) {
      //log('TIMESTAMP');
      latestAds = getDataBeforeTime(ads, latestAdStoredTimestamp);
      
    } else if( Number(latestAdValue) !== 0 ) {
      //log('ID');
      latestAds = getDataBeforeId(ads, Number(latestAdValue) ); // deprecated, replaced by getDataBeforeTime
      
    } else {
      //log('ALL');
      latestAds = ads;
    }
  }
  
  var latestAdsSorted = latestAds.sort( dynamicSort("-timestamp") );
  
  return latestAdsSorted;
}


/**
  * Get data before Id
*/
function getDataBeforeId(data, stopId) {
  
  var stopIndex = data.map(function(x) {return x.id; }).indexOf(stopId);

  return data.slice( 0, stopIndex );
}


/**
  * Get data before time
*/
function getDataBeforeTime(data, lastTime) {
  
  var reducedData = [];
  
  data.map(function(item) {
    
    if (item.timestamp > lastTime) {
      reducedData.push( item );
    }
  });

  return reducedData;
}


/**
  * Set normalized data (inspired by redux & normalizr principles)
*/
function setNormalizedData(key, label, url, latestAds, options) {
 
  // Push new result
  normalizedData.result.push( key );
        
  // Because GAS is not ecmascript 6, we need to use this method to set dynamic object names...
  var obj = {}; obj[key] = {};
  var labels = extend({}, obj);
  var urls = extend({}, obj);
  var ads = extend({}, obj);          
  var custom = extend({}, obj);          
  
  // Extend Labels
  labels[key] = {
    id: key,
    label: label 
  }
  labels = extend({}, normalizedData.entities.labels, labels);  
  
  // Extend urls
  urls[key] = {
    id: key,
    url: url
  }
  urls = extend({}, normalizedData.entities.urls, urls);
  
  // Extend ads
  ads[key] = {
    id: key,
    latest: latestAds
  }
  ads = extend({}, normalizedData.entities.ads, ads);
  
  // Extend custom
  custom[key] = {
    id: key,
    options: options
  }
  custom = extend({}, normalizedData.entities.custom, custom);
  
  // Extend entities
  normalizedData.entities = extend({}, normalizedData.entities, {
    labels: labels,
    urls: urls,
    ads: ads,
    custom: custom
  });
  
}



/**
  * -------------------- *
  *  ABOUT SENDING EMAIL
  * -------------------- *
*/


/**
  * Handle send data
  * TO REFACTOR ?
*/
function handleSendData(data, email, callback) {
  
  var defaultMailResults = [];
  var customMailResults = [];
 
  for (var i = 0; i < data.result.length; i++ ) {
    
    var id = data.result[i];
    var customOptions = data.entities.custom[id].options;

    if (customOptions.email && (customOptions.email !== email) ) {
      
      customMailResults.push( id );
    } else {
      
      defaultMailResults.push( id );
    }
  }

  
  sendDataTo(data, defaultMailResults, email, callback);
  
  
  for (var j = 0; j < customMailResults.length; j++ ) {
    
    var id = customMailResults[j];
    var singleResult = [id];
    var customEmail = data.entities.custom[id].options.email;  
    
    sendSeparatedData(data, singleResult, customEmail, callback);
  }
  
}


/**
  * Send data to
  * TO REFACTOR ?
*/
function sendDataTo( data, results, email, callback ) {
  
  
  if (params.groupedResults) {
    
    sendGroupedData(data, results, email, function(error, result) {
      if (error) {
        sendSeparatedData(data, results, email, callback);
      } else {
        
        if (callback && typeof(callback) === "function") {
          return callback(error, result);
        } 
      }
    });
    
  } else {
    
    sendSeparatedData(data, results, email, callback);
  }
}


/**
  * Send grouped data
*/
function sendGroupedData( data, results, email, callback ) {
    
  var mailTitle =  getMailTitle( results, data.entities );
  var mailHtml = getMailTemplate( results, data.entities, data.update );
  
  sendEmail(email, mailTitle, mailHtml, data.result, callback);
  
}


/**
  * Send separated data
*/
function sendSeparatedData( data, results, email, callback ) {  
  
  for (var i = 0; i < results.length; i++ ) {
    
    var id = data.result[i];
    var singleResult = [id];
    
    var mailTitle =  getMailTitle( singleResult, data.entities );
    var mailHtml = getMailTemplate( singleResult, data.entities, data.update );
    
    sendEmail(email, mailTitle, mailHtml, singleResult, callback);
    
  }
  
}


/**
  * Send email
*/
function sendEmail(email, title, htmlBody, result, callback) {
  
  if (params.debug == true) {
    title = "[debug] " + title;
  }
  
  var error;
  
  try {

    MailApp.sendEmail(
      email,
      title,
      'corps',
      { 
        htmlBody: htmlBody 
      }
    );
    
  } catch(exception) {
    
    log( exception )
    error = exception;
  }
  
  if (callback && typeof(callback) === "function") {
    return callback(error, result);
  }
  //{"message":"Limite dépassée : Taille du corps de l'e-mail.","name":"Exception","fileName":"Code","lineNumber":566,"stack":"\tat Code:566 (sendEmail)\n\tat Code:557 (sendGroupedData)\n\tat Code:530 (sendDataTo)\n\tat Code:256 (start)\n"}
}




/**
  * ------------------ *
  *  ABOUT EMAIL HTML
  * ------------------ *
*/


/**
  * Get mail title
*/
function getMailTitle( result, entities ) {
  
  var length = getAdsTotalLength( result, entities );
  
  var prefixTitle = 'Alertes leboncoin.fr : ';
  var suffixTitle = '';
  
  if (result.length == 1) {
    suffixTitle = ' pour "' + entities.labels[result[0]].label + '"'
  }
  if (result.length > 1) {
    suffixTitle = ' (groupés)'
  }
  
  
  return prefixTitle + length + "\xa0nouveau" + (length > 1 ? "x" : "") + " résultat" + (length > 1 ? "s" : "") + suffixTitle;   
}


/**
  * Get ads length
*/
function getAdsTotalLength( result, entities ) {
  var length = 0;
  for (var i = 0; i < result.length; i++ ) {
    var id = result[i];
    length += entities.ads[id].latest.length;
  }
  return length;
}



/*
  * Get mail template
*/
function getMailTemplate(result, entities, update) {
  
  var template = HtmlService.createTemplateFromFile('mailTemplate');
  template.result = result;
  template.entities = entities;
  template.update = update;
  
  return template.evaluate().getContent();
}


/*
  * Get mail preheader template
*/
function getMailPreheaderTemplate(result, entities) {
  
  var template = HtmlService.createTemplateFromFile('mailTemplate__preheader');
  template.result = result;
  template.entities = entities;
  
  return template.evaluate().getContent();
}


/*
  * Get mail summary template
*/
function getMailSummaryTemplate(result, entities) {
  
  var template = HtmlService.createTemplateFromFile('mailTemplate__summary');
  template.result = result;
  template.entities = entities;
  
  return template.evaluate().getContent();
}


/*
  * Get mail listing template
*/
function getMailListingTemplate( result, entities ) {
  
  var template = HtmlService.createTemplateFromFile('mailTemplate__listing');
  template.result = result;
  template.entities = entities;
  
  return template.evaluate().getContent();
}


/*
  * Get mail ads template
*/
function getMailAdsTemplate( ads, options ) {
  
  var template = HtmlService.createTemplateFromFile('mailTemplate__ads');
  template.ads = ads;
  template.options = options;
  return template.evaluate().getContent();
}


/**
  * Encode data
  * TODO : refactor
*/
function encodeForStaticMapApi(s) {
  if (s) {
  var s = s.trim().replace(/\s\s+/g, '+').replace(/[!'()*]/g, '+');
    //return encodeURIComponent(s);
    return s;
  }
}




/**
  * ------------------------------------- *
  *  ABOUT SPREADSHEET CUSTOM FUNCTIONS
  * ------------------------------------- *
*/


/**
  * For each cell in range
*/
function forEachCellInRange(columnName, startIndex, callback) {
   
  var range = getSpreadsheetContext().getRangeByName(columnName).getValues();
  var startIndex = startIndex - 1 || 0;
  
  for (var i = startIndex, length = range.length; i < length; i++) {

    var index = i + 1;
    var value = range[i][0];
    
    if (value.length && callback && typeof(callback) === "function") {
      callback(index);
    }
  }
  
}

/**
  * Get row by index
*/
function getRowByIndex( index, rangeName, sheetName ) {
  
  return getSheetByName( sheetName ).getRange(index, 1, 1, getColumnByName( rangeName ) );
}

/**
  * Get cell by index
*/
function getCellByIndex( index, rangeName, sheetName ) {
  
  return getSheetByName( sheetName ).getRange(index, getColumnByName( rangeName ) );
}


/**
  * Get range by name
*/
function getRangeByName( rangeName ) {
      
  return getSpreadsheetContext().getRangeByName( rangeName );
}


/**
  * Get column by name
*/
function getColumnByName( rangeName ) {
      
  return getSpreadsheetContext().getRangeByName( rangeName ).getColumn();
}


/**
  * Get spreadsheet context
*/
function getSpreadsheetContext() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  return ss;
}


/**
  * Get data sheet context
*/
function getSheetByName(name) {
  var sheet = getSpreadsheetContext().getSheetByName( name );
  
  return sheet;
}

/**
  * Get data sheet context
*/
function getDataSheetContext() {
  var sheet = getSpreadsheetContext().getSheetByName( params.names.sheet.main );
  
  return sheet;
}

/**
  * Get variables sheet context
*/
function getVariablesSheetContext() {
  var sheet = getSpreadsheetContext().getSheetByName( params.names.sheet.variables );
  
  return sheet;
}


/**
  * Get full range name
*/
function getFullRangeName( rangeName ) {
  
  return names.sheet.main + '!' + rangeName;
}


/**
  * Get values by range name
*/
function getValuesByRangeName(rangeName, asString) {
  // raw 
  var asString = asString || true;
  
  //— for example, getRangeByName('TaxRates') or getRangeByName('Sheet Name!TaxRates'), but not getRangeByName('"Sheet Name"!TaxRates').
  var range = getSpreadsheetContext().getRangeByName(rangeName);
  
  if (asString) {
    return range.getDisplayValues();
  } else {
    return range.getValues();
  }
  
}



/**
  * ----------- *
  * ABOUT UTILS
  * ----------- *
*/


/**
  * Add protocol (https)
*/
function addProtocol(url) {
   if ( url && !/^(f|ht)tps?:\/\//i.test(url) ) {
      url = "https:" + url;
   }
   return url;
}

/**
  * Decode URL
*/
function decodeURL(url) {
  try {
    url = decodeURIComponent(url);
  } catch(e) {
    url = decodeURIComponent( escape(url) );
  }
  return url;
}


/**
  * Log
*/
function log(value, stringify) {
  if (stringify == false) {
    Logger.log ( value );
  }
  return Logger.log( JSON.stringify(value) ); 
 
}

/**
  * Mimic jquery Extend function
*/
function extend() {
  for(var i=1; i<arguments.length; i++)
    for(var key in arguments[i])
      if(arguments[i].hasOwnProperty(key))
        arguments[0][key] = arguments[i][key];
  return arguments[0];
}


/**
  * Deep extend
*/
function deepExtend(out) {
  out = out || {};

  for (var i = 1; i < arguments.length; i++) {
    var obj = arguments[i];

    if (!obj)
      continue;

    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        if (typeof obj[key] === 'object')
          out[key] = deepExtend(out[key], obj[key]);
        else
          out[key] = obj[key];
      }
    }
  }

  return out;
};


/**
 * Get the value of a querystring
 * @param  {String} field The field to get the value of
 * @param  {String} url   The URL to get the value from (optional)
 * @return {String}       The field value
 */
var getQueryString = function ( field, url ) {
    var href = url ? url : window.location.href;
    var reg = new RegExp( '[?&]' + field + '=([^&#]*)', 'i' );
    var string = reg.exec(href);
    return string ? string[1] : null;
};


/*
 * Version compare
 * @author Alexey Bass (albass)
 */
versionCompare = function(left, right) {
    if (typeof left + typeof right != 'stringstring')
        return false;
    
    var a = left.split('.')
    ,   b = right.split('.')
    ,   i = 0, len = Math.max(a.length, b.length);
        
    for (; i < len; i++) {
        if ((a[i] && !b[i] && parseInt(a[i]) > 0) || (parseInt(a[i]) > parseInt(b[i]))) {
            return 1;
        } else if ((b[i] && !a[i] && parseInt(b[i]) > 0) || (parseInt(a[i]) < parseInt(b[i]))) {
            return -1;
        }
    }
    
    return 0;
}

/**
  * Sort object properties
*/
function sortObjectProperties(obj, sortValue, reverse){
  
  var keysSorted;
  if (reverse) {
    keysSorted = Object.keys(obj).sort(function(a,b){return obj[b][sortValue]-obj[a][sortValue]});
  } else {
    keysSorted = Object.keys(obj).sort(function(a,b){return obj[a][sortValue]-obj[b][sortValue]});
  }
  
  var objSorted = {};
  for(var i = 0; i < keysSorted.length; i++){
    objSorted[keysSorted[i]] = obj[keysSorted[i]];
  }
  return objSorted;
}

/**
  * Dynamic Sort
*/
function dynamicSort(property) {
    var sortOrder = 1;
    if(property[0] === "-") {
        sortOrder = -1;
        property = property.substr(1);
    }
    return function (a,b) {
        var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    }
}


/**
  * -------- *
  *  TO KEEP
  * -------- *
*/

/**
  * update recipient email

function onUpdateRecipientEmail() {
  var email = getRecipientEmail();
  showUserEmailWizard(email);
}
*/

/**
* Set recipient email

function setRecipientEmail(value) {

  var cell = getCellByIndex(2, params.names.range.userVarValuesRange, params.names.sheet.variables);
  //var cell = getVariablesSheetContext().getRange( 2, getColumnByName( params.names.range.userVarValuesRange ) );
  //var cell = SpreadsheetApp.getActiveSpreadsheet().getSheetByName( 'Variables' ).getRange(  2, SpreadsheetApp.getActiveSpreadsheet().getRangeByName( 'emailRange' ).getColumn() );
  cell.setValue(value);
    
}
*/

/**
  * Show main trigger wizard

function showUserEmailWizard(email, callbackString) {
  
  var ui = SpreadsheetApp.getUi();
  var template = HtmlService.createTemplateFromFile('userEmailWizardTemplate');
      template.callbackString = callbackString;
      template.email = email;
  
  var html = template.evaluate().setWidth(360).setHeight(120);
  var response = ui.showModelessDialog(html, 'Création email - Alertes LeBonCoin');
}
*/
