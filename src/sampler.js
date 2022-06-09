import { Sampler, ToneAudioBuffers, ToneBufferSource, Panner } from 'tone';
import { flatten, uniq } from 'lodash';

function pitch2PlaybackRate(pitch) {
	return Math.pow(2, pitch / 12);
}

function consolidateRegions(_regions) {
	return flatten(_regions.filter(i => i).map(({ regions, opcodes }) => 
		regions
			? consolidateRegions(
				regions.map(innerRegion => ({
					...innerRegion,
					opcodes: {
						...opcodes,
						...innerRegion.opcodes,
						...opcodes.volume && innerRegion.opcodes.volume
							? { volume: opcodes.volume + innerRegion.opcodes.volume }
							: {},
					} 
				}))
			)
			: opcodes
	));
}

function getAudioFiles(regions) {
	return uniq(regions.map(region => region.sample))
}

function decibelToGain(db) {
	return Math.pow(10, db / 20);
}

export default class Xampler extends Sampler {

	_buffers;

	regions;

	keyMap = new Map();

	constructor({ instrument }) {
		super({});
		this.instrument = instrument;
		console.log(instrument);
		this.baseUrl = `/${instrument.control.opcodes.default_path}`
		this.regions = consolidateRegions(instrument.regions);
		this._buildMap(this.regions);
		this._setBuffers(this.regions);
	}

	_buildMap(regions) {
		regions.forEach(({
			lokey,
			hikey,
			lovel,
			hivel,
			...region
		}) => {
			const midvel = Math.round(lovel + ((hivel - lovel) / 2));
			for (let key = lokey; key < hikey + 1; key++) {
				for (let velocity = lovel; velocity < hivel + 1; velocity++) {
					const noteKey = this.getNoteEventKey(key, velocity);
					if (!Array.isArray(this.keyMap.get(noteKey))) {
						this.keyMap.set(noteKey, []);
					}
					this.keyMap.get(noteKey).push({ ...region, velmod: velocity / midvel });
				}
			}
		});
	}

	_setBuffers(regions) {
		this._buffers = new ToneAudioBuffers(
			getAudioFiles(regions)
				.reduce((acc, file) => ({ ...acc, [file]: this.baseUrl + file }), {})
		);
	}

	getTriggerParams(note, velocity) {
		const [{
			sample,
			volume = 1,
			velmod = 1,
			offset,
			end,
			pan,
			transpose = 0,
		}] = this.keyMap.get(this.getNoteEventKey(note, velocity * 127)) || [{}];
		if (sample) {
			const buffer = this._buffers.get(sample);
			return {
				buffer,
				gain: velmod * decibelToGain(volume),
				offset: offset ? (offset / buffer.sampleRate) : 0,
				duration: end ? (end - offset) / buffer.sampleRate : buffer.duration,
				playbackRate: transpose ? pitch2PlaybackRate(transpose) : 1,
				pan: pan ? pan / 100 : 0,
			};
		}
		
	}

	getNoteEventKey(note, velocity) {
		return [note, velocity].join(':');
	}

	triggerAttack(notes, time, velocity = 1) {
		if (!Array.isArray(notes)) {
			notes = [notes];
		}
		notes.forEach(note => {
			const noteEventKey = this.getNoteEventKey(note, velocity * 127);
			const { buffer, gain, offset, duration, pan, playbackRate } = this.getTriggerParams(note, velocity);
			if (buffer) {
				const source = new ToneBufferSource({
					url: buffer,
					context: this.context,
					playbackRate,
				}).connect(this.output);
				source
					.connect(new Panner(pan).toDestination())
					.start(time, offset, duration, gain * 0.2);
				//add it to the active sources
				if (!Array.isArray(this._activeSources.get(noteEventKey))) {
					this._activeSources.set(noteEventKey, []);
				}
				this._activeSources.get(noteEventKey).push(source);

				// remove it when it's done
				source.onended = () => {
					if (this._activeSources && this._activeSources.has(noteEventKey)) {
						const sources = this._activeSources.get(noteEventKey);
						const index = sources.indexOf(source);
						if (index !== -1) {
							sources.splice(index, 1);
						}
					}
				};
			} else {
				console.warn('No Region found for note', [notes], velocity * 127);
			}
		});
		return this;
	}

};