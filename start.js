const DeepSpeech = require('deepspeech');
const VAD = require('node-vad');
const mic = require('mic');
const fs = require('fs');
const wav = require('wav');
var say = require('say');
const Speaker = require('speaker');
const { exit } = require('process');

let DEEPSPEECH_MODEL; // path to deepspeech model directory
const microphoneInput = "hw:1,0";
if (process.env.DEEPSPEECH_MODEL) {
	DEEPSPEECH_MODEL = process.env.DEEPSPEECH_MODEL;
}
else {
	DEEPSPEECH_MODEL = __dirname + '/german_models/german';
}

let SILENCE_THRESHOLD = 500; // how many milliseconds of inactivity before processing the audio

// const VAD_MODE = VAD.Mode.NORMAL;
// const VAD_MODE = VAD.Mode.LOW_BITRATE;
// const VAD_MODE = VAD.Mode.AGGRESSIVE;
const VAD_MODE = VAD.Mode.VERY_AGGRESSIVE;
const vad = new VAD(VAD_MODE);

function createModel(modelDir) {
	let modelPath = modelDir + '.tflite';
	let scorerPath = modelDir + '.scorer';
	let model = new DeepSpeech.Model(modelPath);
	model.enableExternalScorer(scorerPath);
	return model;
}

let englishModel = createModel(DEEPSPEECH_MODEL);

let modelStream;
let recordedChunks = 0;
let silenceStart = null;
let recordedAudioLength = 0;
let endTimeout = null;
let silenceBuffers = [];
let firstChunkVoice = false;

/* Variablen relevant für Ablauf */
let activated = false;

function processAudioStream(data, callback) {
	vad.processAudio(data, 16000).then((res) => {
		if (firstChunkVoice) {
			firstChunkVoice = false;
			processVoice(data);
			return;
		}
		switch (res) {
			case VAD.Event.ERROR:
				console.log("VAD ERROR");
				break;
			case VAD.Event.NOISE:
				console.log("VAD NOISE");
				break;
			case VAD.Event.SILENCE:
				processSilence(data, callback);
				break;
			case VAD.Event.VOICE:
				processVoice(data);
				break;
			default:
				console.log('default', res);
		}
	});
	
	// timeout after 1s of inactivity
	clearTimeout(endTimeout);
	endTimeout = setTimeout(function() {
		console.log('timeout');
		resetAudioStream();
	},SILENCE_THRESHOLD*3);
}

function endAudioStream(callback) {
	console.log('[end]');
	let results = intermediateDecode();
	if (results) {
		if (callback) {
			callback(results);
		}
	}
}

function resetAudioStream() {
	clearTimeout(endTimeout);
	console.log('[reset]');
	intermediateDecode(); // ignore results
	recordedChunks = 0;
	silenceStart = null;
}

function processSilence(data, callback) {
	if (recordedChunks > 0) { // recording is on
		process.stdout.write('-'); // silence detected while recording
		
		feedAudioContent(data);
		
		if (silenceStart === null) {
			silenceStart = new Date().getTime();
		}
		else {
			let now = new Date().getTime();
			if (now - silenceStart > SILENCE_THRESHOLD) {
				silenceStart = null;
				console.log('[end]');
				let results = intermediateDecode();
				if (results) {
					if (callback) {
						callback(results);
					}
				}
			}
		}
	}
	else {
		process.stdout.write('.'); // silence detected while not recording
		bufferSilence(data);
	}
}

function bufferSilence(data) {
	// VAD has a tendency to cut the first bit of audio data from the start of a recording
	// so keep a buffer of that first bit of audio and in addBufferedSilence() reattach it to the beginning of the recording
	silenceBuffers.push(data);
	if (silenceBuffers.length >= 3) {
		silenceBuffers.shift();
	}
}

function addBufferedSilence(data) {
	let audioBuffer;
	if (silenceBuffers.length) {
		silenceBuffers.push(data);
		let length = 0;
		silenceBuffers.forEach(function (buf) {
			length += buf.length;
		});
		audioBuffer = Buffer.concat(silenceBuffers, length);
		silenceBuffers = [];
	}
	else audioBuffer = data;
	return audioBuffer;
}

function processVoice(data) {
	silenceStart = null;
	if (recordedChunks === 0) {
		console.log('');
		process.stdout.write('[start]'); // recording started
	}
	else {
		process.stdout.write('='); // still recording
	}
	recordedChunks++;
	
	data = addBufferedSilence(data);
	feedAudioContent(data);
}

function createStream() {
	modelStream = englishModel.createStream();
	recordedChunks = 0;
	recordedAudioLength = 0;
}

function finishStream() {
	if (modelStream) {
		let start = new Date();
		let text = modelStream.finishStream();
		if (text) {
			let recogTime = new Date().getTime() - start.getTime();
			return {
				text,
				recogTime,
				audioLength: Math.round(recordedAudioLength)
			};
		}
	}
	silenceBuffers = [];
	modelStream = null;
}

function intermediateDecode() {
	let results = finishStream();
	createStream();
	return results;
}

function feedAudioContent(chunk) {
	recordedAudioLength += (chunk.length / 2) * (1 / 16000) * 1000;
	modelStream.feedAudioContent(chunk);
}

let microphone;
function startMicrophone(callback) {
	if (microphone) {
		console.log('microphone exists');
		return;
	}
	
	createStream();
	microphone = mic({
		rate: '16000',
		channels: '1',
		debug: false,
		device: microphoneInput,
		fileType: 'wav'
	});
	var stream = microphone.getAudioStream();
	console.log(stream);
	stream.on('data', function(data) {
		processAudioStream(data, (results) => {
			callback(results);
		});
	});
	
	microphone.start();
}

function stopMicrophone() {
	console.log(microphone)
	microphone.stop();
	resetAudioStream();
}

function sayWrapper(text){
	say.speak(text, (err) => {
		if (err) {
			return console.error(err);
		}
	
		console.log('Text has been spoken.');
	});
}

let ueberweisungCounter = 0;

function onRecognize(results) {
	console.log(ueberweisungCounter, activated)
	console.log('recognized:', results);
	if (results.text === 'stop') {
		console.log('stoppt...');
		stopMicrophone();
		process.exit();
 	} if (results.text === 'danke'){
		sayWrapper('Kein Problem. Kann ich dir noch mit etwas helfen?')
	} if (results.text === 'hallo geldbeutel'){
		activated = true;
		sayWrapper('Hallo Felix. Du befindest dich auf deinem Konto Mastercard. Wie kann ich dir helfen?')
	} else if (activated) {
		if (ueberweisungCounter == 0){
			if (results.text === 'sende eine überweisung an mark'){	
				sayWrapper('Welchen Betrag soll ich an Mark überweisen?')
				ueberweisungCounter = 1;
				exit;
			}
		}else if(ueberweisungCounter == 1){
			if(results.text === 'hundert euro'){
				ueberweisungCounter = 2;
				sayWrapper('Wann soll die Überweisung stattfinden? Nenne mir ein Datum oder sofort')
				exit;
			}
		} else if(ueberweisungCounter == 2){
			if(results.text === 'sofort'){
				sayWrapper('Bitte bestätige die Überweisung per TAN oder auf deinem entsprechenden Gerät')
				setTimeout(function (){
					sayWrapper('Danke. Die Überweisung von 100 Euro wurde so eben an Mark gesendet.')
				}, 10000);
				ueberweisungCounter = 0;
			}
		}
	}
}

if (process.argv[2]) {
	// if an audio file is supplied as an argument, play through the speakers to be picked up by the microphone
	console.log('play audio file', process.argv[2]);
	var file = fs.createReadStream(process.argv[2]);
	var reader = new wav.Reader();
	reader.on('format', function (format) {
		firstChunkVoice = true;   // override vad for this test
		SILENCE_THRESHOLD = 1000; // override silence (debounce time)
		startMicrophone(function(results) {
			console.log(results);
			process.exit();
		});
		setTimeout(function() {
			reader.pipe(new Speaker(format));
		},900);
	});
	file.pipe(reader);
}
else {
	startMicrophone(onRecognize);
}
