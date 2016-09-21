const http = require('http');
const express = require('express');
const fs = require('fs');
const request = require('request');
const cheerio = require('cheerio');
const Crawler = require("simplecrawler");
const EasyXml = require('easyxml');
const firebase = require('firebase');
const gcloud = require('google-cloud');
const winston = require('winston');
const Q = require('q');
const _ = require('underscore');

var app = express();
var server = http.createServer(app)

//winston.level = 'debug'  
//require('request-debug')(request);

firebase.initializeApp({
  serviceAccount: "athome-scrapper-8be17f7116fe.json",
  databaseURL: "https://athome-scrapper.firebaseio.com"
});

// Create a database reference
var db = firebase.database();
var announcersRef = db.ref("athome-announcers");
var propertiesRef = db.ref("athome-properties");

// Create a storage reference
var gcs = gcloud.storage({
  projectId: 'athome-scrapper',
  keyFilename: "athome-scrapper-8be17f7116fe.json"
});
var propertiesPictures = gcs.bucket('athome-scrapper.appspot.com');
var atHomeImagesServer = "http://i1.static.athome.eu/images/annonces2/image_"

function updateStorageURL(file, path, gsURL) {
    file.acl.add({
          entity: 'allUsers',
          role: gcs.acl.READER_ROLE
        }, function(err, aclObject) {});
    propertiesRef.child(path).set(gsURL);
    winston.log('debug', 'Picture downloaded ', {
        path:path,
        gsURL:gsURL,
    });
}

// Save file to Firebase from a URL
function saveFile(fileName, path, key, num) {
    var gsURL = 'http://storage.googleapis.com/athome-scrapper.appspot.com/athome-properties/pictures/'+key+'/picture'+num+'.jpg';
    var file = propertiesPictures.file('athome-properties/pictures/'+key+'/picture'+num+'.jpg');
    var writeStream = fs.createWriteStream('./output.jpg');
    
    winston.log('debug', 'Download picture - ', {
            url : atHomeImagesServer+fileName,
    });
    
    request.get(atHomeImagesServer+fileName)
    .pipe(file.createWriteStream({
                metadata: {
                    contentType: 'image/jpeg',
                    metadata: {
                    custom: 'metadata'
                }
            }
    }))
    .on('error', function(err) {
        winston.log('debug', 'Error downloading picture - ', {
            errannouncerId : err,
        });
    })
    .on('finish', function() {
        file.acl.add({
          entity: 'allUsers',
          role: gcs.acl.READER_ROLE
        }, function(err, aclObject) {});
        propertiesRef.child(path+'/pictures/picture'+num).set(gsURL);
        winston.log('debug', 'Picture downloaded ', {
            path:path,
            gsURL:gsURL,
        });
    });
}

app.get('/announcers', function(req, res){
    announcersRef.once("value", function(data) {
        res.json(data.val());
    });
});

app.get('/scrape/:announcerId', function(req, res){

    announcersRef.child(req.params.announcerId).once("value", function(data) {
        var announcer = data.val();
        var url = announcer.url;
        var crawlPattern = new RegExp(announcer.crawlPattern, "i");
        
        var properties = {};
        
        winston.log('debug', 'Start crawling - ', {
                announcerId : req.params.announcerId,
                url : url,
                crawlPattern : announcer.crawlPattern,
        })
        
        var mainPages = [];
        
        var mainCrawler = new Crawler(url);
        
        mainCrawler.addFetchCondition(function(parsedURL) {
            /*winston.log('debug', 'Query pattern for page - ', {
                url : parsedURL,
            })*/
            return parsedURL.path.match(crawlPattern);
        });
        
        mainCrawler.on("fetchcomplete", function(queueItem) {
                winston.log('debug', 'Queue page - ', {
                    url : queueItem.url,
                })
                mainPages.push(queueItem.url);
            });
            
        mainCrawler.on("complete", function() {
                winston.log('debug', 'All main pages crawled start crawling properties - ', {
                    pages : mainPages,
                    pageCount : mainPages.length,
                })
                
                var promisses = [];
                
                propertiesRef.child(req.params.announcerId)
                
                for (i = 0; i < mainPages.length; i++) {
                    var page = mainPages[i];
                    winston.log('debug', 'Start crawling - ', {
                        url : page,
                    })
                    var pageCrawler = new Crawler(page);
                    pageCrawler.maxDepth = 2; // do not index properties recursively
                    pageCrawler.addFetchCondition(function(parsedURL) {
                        return parsedURL.path.match(/[\/\w \.-]*[0-9]{7,7}$/i);
                    });
                    
                    pageCrawler.on("fetchcomplete", function(queueItem) {
                        if(queueItem.url.match(/[\/\w \.-]*[0-9]{7,7}$/i)){
                            winston.log('debug', 'Start crawling property - ', {
                                url : queueItem.url,
                            })
                            request(queueItem.url,function(error, response, html) {
                                if(!error){
                                    try {
                                        var property_json = html.match(/initGoogleMap\((\[.*\])/i)[1];
                                        var property = JSON.parse(property_json)[0];
                                        //remove this for now as xml encoding fail
                                        delete property.specifications;
                                        
                                        var $ = cheerio.load(html);
                                        property.atHomeUrl = queueItem.url;
                                        property.title = $("meta[name='og:title']").attr("content");
                                        property.type = html.match(/googletag\.pubads\(\)\.setTargeting\("Type", \"(.*)\" \)/i)[1];
                                        property.categories = queueItem.url.match(/http:\/\/www\.athome\.lu\/([\w \.-]*)\/([\w \.-]*)\/([\w \.-]*)\/([\w \.-]*)\/([\w \.-]*)/i);
                                        // remove all properties with value at '-1' as they hold no information
                                        property = _.pick(property, function(value, key) {return value != -1;})
                                        
                                        propertiesRef.child(req.params.announcerId+'/'+property.id).set(property)
                                        
                                        // Get all image into Firebase storage
                                        for(var i = 1; i <= 10; i++){
                                            if (property.pictures['picture'+i]){
                                                saveFile(property.pictures['picture'+i],req.params.announcerId+'/'+property.id,property.id,i);
                                            }
                                        }
                                        
                                        winston.log('debug', 'Property crawled - ', {
                                            title : property.title,
                                        })
                                        
                                    } catch(err) {
                                        winston.log('debug', 'Error crawling property - ', {
                                            error : err,
                                        })
                                    }
                                } else {
                                    winston.log('debug', 'Error getting the property - ', {
                                        error : error,
                                    })
                                }
                            });
                        }
                    });
                    
                    var deferred = Q.defer();
                    promisses.push(deferred.promise);
                    pageCrawler.deferred = deferred;
                    pageCrawler.on("complete", function() {
                        winston.log('debug', 'End page crawling - ', {
                            url : this.initialPath,
                        })
                        this.deferred.resolve();
                    });
                    
                    pageCrawler.start();
                }
                
                Q.all(promisses).then(function() {
                    winston.log('debug', 'Crawling properties is finished ! ', {
                    })
                    propertiesRef.child(req.params.announcerId).once('value').then(function(snapshot) {
                        res.json(snapshot.val());
                    });
                })
            });
            mainCrawler.start();
    });
});

server.listen(process.env.PORT  || 3000, process.env.IP || "0.0.0.0", function(){
    var addr = server.address();
    console.log("Connect to ", addr.address + ":" + addr.port);
});