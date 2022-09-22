process.env.NTBA_FIX_319 = 1;
process.env.NTBA_FIX_350 = 1;

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
const TelegramBot = require('node-telegram-bot-api');
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
const storeFile = jsonfile.readFileSync('.store.json',{throws:false});
const secFile = jsonfile.readFileSync('.secrets.json',{throws:false});

var bot;
if(secFile && secFile.telegram && secFile.telegram.token && secFile.telegram.authorized){
	bot = new TelegramBot(secFile.telegram.token, {polling: true});
	console.log('bot online');
	bot.on('message', async function(msg){
		const chatId = msg.chat.id;
		if(!secFile.telegram.authorized[chatId]) {
			bot.sendMessage(chatId, 'Unauthorized! Ask for permission. Your Telegram ID is: '+chatId);
		} else {
			if(msg.text == '/start' || msg.text == 'help' || msg.text == 'Help' ||msg.text == 'HELP'){
				bot.sendMessage(chatId, 
					'send .mp4 or .jpeg to display in stream (15s for photo)'
				);
			}
			else if(msg.video) {
					
				try{
					
					bot.downloadFile(msg.video.file_id, '/tmp').then(async function(path){
						io.emit('video', path.split('/')[2]);
					});

				} catch(err) {
					console.log(err);
				}
			}
			else if(msg.photo) {
					
				try{
					const fileid = msg.photo[msg.photo.length-1].file_id; 
					const stream = bot.getFileStream(fileid);
					const bufs = [];
					stream.on('data', function(d){ bufs.push(d); });
					stream.on('end', function(){
						io.emit('image', Buffer.concat(bufs).toString('base64'));
						console.log('display image');
					});
				} catch(err) {
					console.log(err);
				}
			}else if(msg.document && (msg.document.mime_type == 'image/png')) {
					
				try{
					const stream = bot.getFileStream(msg.document.file_id);
					const bufs = [];
					stream.on('data', function(d){ bufs.push(d); });
					stream.on('end', function(){
						io.emit('image', Buffer.concat(bufs).toString('base64'));
					});
				} catch(err) {
					console.log(err);
				}
			}else{
				bot.sendMessage(chatId, 'unknown command, try \'help\'');
			}
		}
	});
}

var gridStore = (storeFile && storeFile.gridStore) || {};

function exitHandler(callback) {
	
	jsonfile.writeFileSync('.store.json', {
		gridStore:gridStore
	});

	callback();
}


process.on('SIGINT', () => {
	exitHandler(() => process.exit(-1));
});

async function getVolumes()
{
	for(var i = 1;i<11;i++)
	{
		var vol = (await obs.call('GetInputVolume',{'inputName': 'P'+i})).inputVolumeDb;
		io.emit('volume',i,Math.round(Math.pow((vol+100)/21.544,3)));
	}
	itemId = (await obs.call('GetSceneItemId',{'sceneName': 'Szene','sourceName': 'TD'})).sceneItemId;
	tdEnabled = (await obs.call('GetSceneItemEnabled',{'sceneName': 'Szene',sceneItemId:itemId})).sceneItemEnabled;
	io.emit('tweetdeck',tdEnabled);
}

io.on('connection', (socket) => {
	console.log('conn');
	socket.on('log', (text) => {
		console.log('browser:'+text);
	});
	socket.on('ctrlinit', (text) => {
		io.emit('ctrlinit');
				
		if(obsConnected){
			getVolumes();
		}

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
					eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters | EventSubscription.SceneItemTransformChanged
				}
			)
			.then(() => {
				console.log(`Success! We're connected & authenticated.`);
				obsConnected = true;
				obs.on('InputVolumeChanged', ev => {
					io.emit('volume',ev.inputName.substring(1),Math.round(Math.pow((ev.inputVolumeDb+100)/21.544,3)));
				});
				obs.on('SceneItemEnableStateChanged', async(ev) => {
					console.log(ev);
					var list = (await obs.call('GetSceneItemList',{'sceneName': 'Szene',})).sceneItems;
					for(var item of list){
						if((ev.sceneItemId == item.sceneItemId)&&(item.sourceName == 'TD'))
						{
							io.emit('tweetdeck',ev.sceneItemEnabled);
						}
					}
				});
				obs.on('CustomEvent', ev => {
					if(ev.cmd && ev.cmd == 'log'){
						io.emit('ffmpeg_log',ev.data);
					}
				});
				obs.on('SceneItemTransformChanged', async (ev) => {
					var list = (await obs.call('GetSceneItemList',{'sceneName': 'Szene',})).sceneItems;
					for(var item of list){
						if(ev.sceneItemId == item.sceneItemId)
						{
							var idx = item.sourceName.substring(1);
							io.emit('pos',idx,
								ev.sceneItemTransform.positionX,
								ev.sceneItemTransform.positionY,
								ev.sceneItemTransform.width,
								ev.sceneItemTransform.height
							);
						}
					}
				});
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
						io.emit('play_hls',idx,'yt: '+data.metadata.author+' - '+data.metadata.title,url,data.streams['720p'].url);
						socket.emit('state',idx,'yt: '+data.metadata.author+' - '+data.metadata.title);
					}else{
						if(data.streams && data.streams['best'] && data.streams['best'].type=='hls'){
							io.emit('play_hls',idx,'yt: '+data.metadata.author+' - '+data.metadata.title,url,data.streams['best'].url);
							socket.emit('state',idx,'yt: '+data.metadata.author+' - '+data.metadata.title);
						}else{
							socket.emit('state',idx,'yt: not live');
						}
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
				
					//streamlink <url> 720p,best --player=ffmpeg -v -a '-i {playerinput} -hide_banner -loglevel warning -c copy -f mpegts srt://127.0.0.1:4445'

				}
				//console.log(data);
			}
		});
	});
	socket.on('stop', (idx) => {
		io.emit('stop',idx);
	});
	socket.on('stop_hls', () => {
		obs.call('BroadcastCustomEvent',{eventData: {cmd:'stream_hls_stop'}});
	});
	socket.on('start_hls', (url) => {
		obs.call('BroadcastCustomEvent',{eventData: {cmd:'stream_hls',data:url}});
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
	socket.on('overlayInit',()=>{
		io.emit('overlayInit');
	});
	socket.on('overlayInit_resp',(cube,clock,clock_pos)=>{
		io.emit('overlayInit_resp',cube,clock,clock_pos);
	});
	socket.on('grid', (grid, gridArr, id) => {
		gridStore[id]=gridArr;
		if(grid == '6x6'){
			var gridMap = {};
			for(const player of Object.keys(players)){

				var gridPos = {};
				for (var x = 0; x < 6; x++) {
					for (var y = 0; y < 6; y++) {
						if(gridArr[y][x] == player){
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
		if(grid == '4x4'){
			var gridMap = {};
			for(const player of Object.keys(players)){

				var gridPos = {};
				for (var x = 0; x < 4; x++) {
					for (var y = 0; y < 4; y++) {
						if(gridArr[y][x] == player){
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
	const itemId = (await obs.call('GetSceneItemId',{'sceneName': 'Szene','sourceName': 'P'+player})).sceneItemId;
	const transform = (await obs.call('GetSceneItemTransform',{'sceneName': 'Szene','sceneItemId': itemId})).sceneItemTransform;
	
	if(undefined === gridPos.topLeftX) {
		//obs.call('SetSceneItemTransform',{'sceneName': 'Szene','sceneItemId': itemId,sceneItemTransform:{positionY:0,positionX:1920}});
		tileAnimate(itemId,30,1,transform.positionX,transform.positionY,transform.scaleX,transform.scaleY,1920,transform.positionY,transform.scaleX,transform.scaleY);
	}else{

		const width = (transform.sourceWidth - (transform.cropLeft + transform.cropRight))
		const height = (transform.sourceHeight - (transform.cropTop + transform.cropBottom))

		const gridX = gridPos.bottomRightX-gridPos.topLeftX+1;
		const gridY = gridPos.bottomRightY-gridPos.topLeftY+1;

		var tileX;
		var tileY;
		if(grid == '6x6'){
			tileX=320;
			tileY=180;
		}
		if(grid == '4x4'){
			tileX=480;
			tileY=270;
		}
		if(grid == '3x3'){
			tileX=640;
			tileY=360;
		}

		var	boxX = gridX*tileX;
		var	boxY = gridY*tileY;
		const scaleX = boxX/width;
		const scaleY = boxY/height;
		const scale = Math.min(scaleX,scaleY)

		const addX=(boxX-(width*scale))/2;
		const addY=(boxY-(height*scale))/2;

/*
		obs.call('SetSceneItemTransform',{'sceneName': 'Szene','sceneItemId': itemId,sceneItemTransform:{
			positionX:gridPos.topLeftX*tileX+addX,
			positionY:gridPos.topLeftY*tileY+addY,
			scaleX: scale,
			scaleY: scale
		}});
*/

		tileAnimate(itemId,30,1,transform.positionX,transform.positionY,transform.scaleX,transform.scaleY,gridPos.topLeftX*tileX+addX,gridPos.topLeftY*tileY+addY,scale,scale);
	}
}
function tileAnimate(itemId,steps,step,opX,opY,osX,osY,pX,pY,sX,sY){

		obs.call('SetSceneItemTransform',{'sceneName': 'Szene','sceneItemId': itemId,sceneItemTransform:{
			positionX:opX-(((opX-pX)/steps)*step),
			positionY:opY-(((opY-pY)/steps)*step),
			scaleX: osX-(((osX-sX)/steps)*step),
			scaleY: osY-(((osY-sY)/steps)*step)
		}});

		if(steps != step){
			setTimeout(function(){tileAnimate(itemId,steps,step+1,opX,opY,osX,osY,pX,pY,sX,sY)},10);
		}

}
