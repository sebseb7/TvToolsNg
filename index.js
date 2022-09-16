const { spawn } = require('child_process');
const express = require('express');
const app = express();
const http = require('http');
const path = require('path');
const httpServer = http.createServer(app);
const io = require("socket.io")(httpServer, {transports:['websocket']});
const cors_proxy = require('cors-anywhere');
const OBSWebSocket = require('obs-websocket-js').default;
const {EventSubscription} = require('obs-websocket-js');
const obs = new OBSWebSocket();
const jsonfile = require('jsonfile');
cors_proxy.createServer({
	originWhitelist: [], // Allow all origins
	//requireHeader: ['origin', 'x-requested-with'],
	removeHeaders: ['cookie', 'cookie2']
}).listen(8111, '0.0.0.0', function() {
});

app.get('/player.html', function(req,res){
	res.sendFile(path.join(__dirname, 'player.html'));
});
app.get('/overlay.html', function(req,res){
	res.sendFile(path.join(__dirname, 'overlay.html'));
});
app.get('/', function(req,res){
	res.sendFile(path.join(__dirname, 'ctrl.html'));
});
app.get('/hls.js', function(req,res){
	res.sendFile(path.join(__dirname, 'hls.js'));
});
httpServer.listen(8110,'0.0.0.0');

var obsConnected = false;

function resolve(url,cb) {

	var	process = spawn('streamlink',['-j','\''+url+'\''],{shell: true});

	process.stdout.on('data', function(data) 
	{
		if(this.completeData){
			this.completeData= this.completeData.concat(data);
		}else{
			this.completeData=data;
		}
	});
	process.stderr.on('data', (data) => {
	});

	process.on('close', function(code) {
		try {
			var result = JSON.parse(this.stdout.completeData);
			if(result.error){
				cb(result.error,null);
			}else{
				cb(null,result);
			}
		} catch(e) {
		
			cb(e.toString(),null);
		}
	});

}

var obsIp = null;
var players = {};
const storeFile = jsonfile.readFileSync('.store.json');
var gridStore = storeFile.gridStore || {};

function exitHandler(callback) {
	
	jsonfile.writeFileSync('.store.json', {
		gridStore:gridStore
	});

	callback();
}


process.on('SIGINT', () => {
	exitHandler(() => process.exit(-1));
});

io.on('connection', (socket) => {
	console.log('conn');
	socket.on('log', (text) => {
		console.log('browser:'+text);
	});
	socket.on('ctrlinit', (text) => {
		io.emit('ctrlinit');
	});
	socket.on('ctrlinit_resp', (idx,url,text) => {
		io.emit('ctrlinit_resp',idx,url,text);
	});
	socket.on('player_init', (idx) => {
		io.emit('player_init',idx);
		players[idx]=true;
		if(obsIp == null){
			obsIp = socket.handshake.address;
			obs.connect(
				url = 'ws://'+obsIp+':4455',undefined,
				{
					eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters
				}
			)
			.then(() => {
				console.log(`Success! We're connected & authenticated.`);
				obsConnected = true;
				//startup();
			})
		}
	});
	socket.on('load', (idx,url) => {
		resolve(url,(err,data)=>{
			if(err){
				socket.emit('state',idx,err);
			}else{
				if(data.plugin && data.plugin == 'facebook' && data.metadata){
					
					if(data.streams && data.streams['best'] && data.streams['best'].type=='dash'){
						io.emit('play_dash',idx,'fb: '+data.metadata.title,url,data.streams['best'].url);
						socket.emit('state',idx,'fb: '+data.metadata.title);
					}else{
						socket.emit('state',idx,'fb: not live');
					}
				}
				if(data.plugin && data.plugin == 'youtube' && data.metadata){
					
					if(data.streams && data.streams['720p'] && data.streams['720p'].type=='hls'){
						io.emit('play_hls',idx,'yt: '+data.metadata.author+' - '+data.metadata.title,url,data.streams['best'].url);
						socket.emit('state',idx,'yt: '+data.metadata.author+' - '+data.metadata.title);
					}else{
						socket.emit('state',idx,'yt: not live');
					}
				}
				if(data.plugin && data.plugin == 'hls'){
					
					if(data.streams && data.streams['best'] && data.streams['best'].type=='hls'){
						io.emit('play_hls',idx,'hls',url,data.streams['best'].url);
						socket.emit('state',idx,'hls');
					}else{
						socket.emit('state',idx,'hls: not live');
					}
				}
				if(data.plugin && data.plugin == 'dlive' && data.metadata){
					
					if(data.streams && data.streams['best'] && data.streams['best'].type=='hls'){
						//io.emit('play_hls',idx,'hls',url,data.streams['best'].url,'noproxy');
						io.emit('play_hls',idx,'hls',url,data.streams['best'].url);
						socket.emit('state',idx,'dlive: '+data.metadata.author+' - '+data.metadata.title);
					}else{
						socket.emit('state',idx,'dlive: not live');
					}
				}
				//console.log(data);
			}
		});
	});
	socket.on('stop', (idx) => {
		io.emit('stop',idx);
	});
	socket.on('disconnect', () => {
		console.log('dis');
	});
	socket.on('reconnect', (num) => {
		console.log('rec '+num);
	});
	socket.on('error', (error) => {
		console.log('socket err:'+error);
	});
	socket.on('getGrid',(cb)=>{
		cb(gridStore);
	});
	socket.on('grid', (grid, gridArr, id) => {
		gridStore[id]=gridArr;
		if(grid == '4x4'){
			var gridMap = {};
			for(const player of Object.keys(players)){

				var gridPos = {};
				for (var x = 0; x < 4; x++) {
					for (var y = 0; y < 4; y++) {
						if(gridArr[y][x] == player){
							console.log(player,x,y);
							if( (undefined === gridPos.topLeftX) || gridPos.topLeftX>x){
								gridPos.topLeftX=x;
							}
							if( (undefined === gridPos.topLeftY) || gridPos.topLeftY>y){
								gridPos.topLeftY=y;
							}
							if((undefined === gridPos.bottomRightX) || gridPos.bottomRightX<x){
								gridPos.bottomRightX=x;
							}
							if((undefined === gridPos.bottomRightY) || gridPos.bottomRightY<y){
								gridPos.bottomRightY=y;
							}
						}
					}
				}

				if(obsConnected){
					setPosition(player,gridPos,grid);
				}
			}
		}
		if(grid == '3x3'){
			var gridMap = {};
			for(const player of Object.keys(players)){

				var gridPos = {};
				for (var x = 0; x < 3; x++) {
					for (var y = 0; y < 3; y++) {
						if(gridArr[y][x] == player){
							console.log(player,x,y);
							if( (undefined === gridPos.topLeftX) || gridPos.topLeftX>x){
								gridPos.topLeftX=x;
							}
							if( (undefined === gridPos.topLeftY) || gridPos.topLeftY>y){
								gridPos.topLeftY=y;
							}
							if((undefined === gridPos.bottomRightX) || gridPos.bottomRightX<x){
								gridPos.bottomRightX=x;
							}
							if((undefined === gridPos.bottomRightY) || gridPos.bottomRightY<y){
								gridPos.bottomRightY=y;
							}
						}
					}
				}

				if(obsConnected){
					setPosition(player,gridPos,grid);
				}
			}
		}
	});
	socket.on('volume', (idx, volume) => {
		obs.call('SetInputVolume',{'inputName': 'P'+idx,'inputVolumeDb': Math.cbrt(parseInt(volume))*21.544-100});
	});
	socket.on('tweetdeck', async (enabled) => {
		itemId = (await obs.call('GetSceneItemId',{'sceneName': 'Szene','sourceName': 'TD'})).sceneItemId;
		obs.call('SetSceneItemEnabled',{'sceneName': 'Szene',sceneItemId:itemId,'sceneItemEnabled': enabled});
	});
	socket.on('clock', (enabled) => {
		io.emit('clock',enabled);
	});
	socket.on('cube', (enabled) => {
		io.emit('cube',enabled);
	});
	socket.on('clockPos', (left) => {
		io.emit('clockPos',left);
	});
});
					
async function setPosition(player,gridPos,grid){
	var itemId = (await obs.call('GetSceneItemId',{'sceneName': 'Szene','sourceName': 'P'+player})).sceneItemId;
	//var tr = (await obs.call('GetSceneItemTransform',{'sceneName': 'Szene','sceneItemId': itemId}));
	
	if(undefined === gridPos.topLeftX) {
		obs.call('SetSceneItemTransform',{'sceneName': 'Szene','sceneItemId': itemId,sceneItemTransform:{positionY:0,positionX:1920}});
	}else{
		var scaleX = gridPos.bottomRightX-gridPos.topLeftX+1;
		var scaleY = gridPos.bottomRightY-gridPos.topLeftY+1;
		var scale = Math.min(scaleX,scaleY);
		var addX=0;
		var addY=0;

		if(scaleX>scaleY) addX = scaleX-scaleY;
		if(scaleY>scaleX) addY = scaleY-scaleX;
		
		if(grid == '4x4'){

			obs.call('SetSceneItemTransform',{'sceneName': 'Szene','sceneItemId': itemId,sceneItemTransform:{
				positionX:gridPos.topLeftX*480+(addX*240),
				positionY:gridPos.topLeftY*270+(addY*135),
				scaleX: scale*0.5,
				scaleY: scale*0.5
			}});
		}
		if(grid == '3x3'){
			obs.call('SetSceneItemTransform',{'sceneName': 'Szene','sceneItemId': itemId,sceneItemTransform:{
				positionX:gridPos.topLeftX*640+(addX*320),
				positionY:gridPos.topLeftY*360+(addY*180),
				scaleX: scale*0.666,
				scaleY: scale*0.666
			}});
		}
	}

}

