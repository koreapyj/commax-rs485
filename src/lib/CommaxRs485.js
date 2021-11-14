import { Buffer } from 'buffer';
import SerialPort from "serialport";
import EventEmitter from "events";

const RETRY_AFTER = 30;

export class Packet {
    #raw

    get raw() {
        return this.#raw;
    }

    constructor(...args) {
        if(args.length !== 1 || !(args[0] instanceof Buffer)) {
            return this.constructor.create(this, ...args);
        }

        const packet = args[0];

        this.#raw = packet;
        if((this instanceof InvalidPacket)) return;
        if(!(this instanceof InvalidPacket) && !this.check()) {
            return new InvalidPacket(packet);
        }

        this.type = packet[0] & ~0x80;
        this.id = packet[2];

        return this.constructor.parse(this);
    }

    check() {
        const checksum = this.constructor.checksum(this.raw);

        if(this.raw[7] != checksum) {
            return false;
        }

        return true;
    }

    static create() {
    }

    static parse(packet) {
        if(packet.raw[0] & 0x80) return new ReplyPacket(packet.raw);
        else return new RequestPacket(packet.raw);
    }

    static checksum(buffer) {
        let checksum = 0;
        for(let i = 0 ; i < 7 ; i++) {
            checksum += buffer[i];
        }
        checksum = checksum & 0xff;
        return checksum;
    }
}

export class InvalidPacket extends Packet { }
export class TimePacket extends Packet {
    static parse(packet) { }
    constructor(packet) {
        super(packet);

        this.id = null;
        this.timestamp = new Date(`20${packet[1].toString(16).padStart(2, '0')}-${packet[2].toString(16).padStart(2, '0')}-${packet[3].toString(16).padStart(2, '0')} ${packet[4].toString(16).padStart(2, '0')}:${packet[5].toString(16).padStart(2, '0')}:${packet[6].toString(16).padStart(2, '0')} +0900`);
    }
}
export class RequestPacket extends Packet {
    static insertChecksum(buffer) {
        return Buffer.from([...buffer.slice(0,7), this.checksum(buffer)]);
    }

    static parse(packet) {
        switch(packet.type) {
            case 0x78:
                return new FanRequestPacket(packet.raw);
                break;
            case 0x7f:
                return new TimePacket(packet.raw);
                break;
            default:
        }
    }
}

export class LightRequestPacket extends RequestPacket {
    static create(_this, options) {
        console.log(options);
        switch(options.name) {
            case 'state':
                return new this(this.insertChecksum(Buffer.from([
                    0x31,
                    options.id & 0xff,
                    options.value,
                    0x00,
                    0x00,
                    0x00,
                    0x00,
                    0x00,
                ])));
                break;
            default:
                throw new TypeError;
        }
    }
}

export class ReplyPacket extends Packet {
    static parse(packet) {
        switch(packet.type) {
            case 0x02: /* 보일러 */
                return new ThermostatReplyPacket(packet.raw);
            case 0x31: /* ACK */
                console.log(packet.raw);
            case 0x30: /* 조명 */
                return new LightReplyPacket(packet.raw);
            case 0x20: /* 일괄소등 스위치 */
                return new SwitchReplyPacket(packet.raw);
            case 0x76: /* 전열교환기 */
                return new FanReplyPacket(packet.raw);
            case 0x79: /* 대기전력차단스위치 */
                if(packet.raw[3] === 0x10) return new OutletEnergyMeterReplyPacket(packet.raw);
                if(packet.raw[3] === 0x20) return new OutletReplyPacket(packet.raw);
            default:
        }
    }
}

export class FanRequestPacket extends RequestPacket {
    static parse(packet) {
        switch(packet.raw[2]) {
            case 0x1:
                packet.state = {0x0: 'off', 0x2: 'auto', 0x4: 'manual', 0x6: 'sleep', 0x7: 'supply', 0x8: 'heat'}[packet.raw[3]] || `unknown(${packet.raw[3]})`;
                break;
            case 0x2:
                packet.fanSpeed = {0x0: 'speed_off', 0x1: 'speed_low', 0x2: 'speed_middle', 0x3: 'speed_high'}[packet.raw[3]] || `unknown(${packet.raw[3]})`;
                break;
            case 0x3:
                packet.timer = packet.timerRemainingSec = (packet.raw[3]*60+packet.raw[4])*60;
                break;
        }
    }
}

export class FanReplyPacket extends ReplyPacket {
    static parse(packet) {
        packet.state = {0x0: 'off', 0x2: 'auto', 0x4: 'manual', 0x6: 'sleep', 0x7: 'supply', 0x8: 'heat'}[packet.raw[1]] || `unknown(${packet.raw[1]})`;
        packet.currentFanSpeedSetting = {0x0: 'speed_off', 0x1: 'speed_low', 0x2: 'speed_middle', 0x3: 'speed_high'}[packet.raw[3]] || `unknown(${packet.raw[3]})`;
        packet.timerRemainingSec = packet.raw[4] ? (packet.raw[5]*60+packet.raw[6])*60 : -1;
    }
}

export class ThermostatReplyPacket extends ReplyPacket {
    static parse(packet) {
        packet.state = {0x81: 'HEAT', 0x84: 'OFF'}[packet.raw[1]] || `unknown(${packet.raw[1]})`;
        packet.thermostatTemperatureAmbient = ~~packet.raw[3].toString(16);
        packet.thermostatTemperatureSetpoint = ~~packet.raw[4].toString(16);
    }
}

export class SwitchReplyPacket extends ReplyPacket {
    static parse(packet) {
        packet.state = packet.raw[1] & 0xf;
    }
}

export class OutletReplyPacket extends SwitchReplyPacket {
    static parse(packet) {
        super.parse(packet);
        packet.currentModeSetting = {0x10: 'auto', 0x0: 'manual'}[packet.raw[1] & 0xf0];
        packet.threshold = ~~packet.raw[6].toString(16);
    }
}

export class LightReplyPacket extends SwitchReplyPacket {
}

export class SensorReplyPacket extends ReplyPacket {
    static parse(packet) { }
}

export class OutletEnergyMeterReplyPacket extends SensorReplyPacket {
    static parse(packet) {
        packet.energyUsage = ~~packet.raw.slice(5,7).toString('hex');
    }
}

export class Listener extends EventEmitter {
    #chunkBuf
    #isPeacefulClose
    #config
    #isCalibrating = false
    #publishQueue = []
    #publishQueueLock = false

    constructor(options) {
        const defConfig = {};
        const {
            port,
        } = {...defConfig, ...options};
        super();
        this.#config = options;
        this.#chunkBuf = null;
        this.#isPeacefulClose = false;
        this.serial = new SerialPort(port);
        this.serial.on('data', chunk => this.#onData(chunk));
        this.serial.on('open', () => this.#onOpen());
        this.serial.on('close', () => this.#onClose());
        this.serial.on('error', () => this.#onError());
    }

    get online() {
        return this.serial.isOpen;
    }

    publish(packet, callback) {
        console.log('rs485 queued', packet.raw);
        this.#publishQueue.push({
            message: packet.raw,
            callback
        });
    }

    shutdown(cb) {
        if(this.online) {
            console.log('INFO: Commax RS485 bridge shutting down...');
            this.#isPeacefulClose = true;
            this.serial.close(cb);
        }
        else return cb();
    }

    calibrate(invalid_packets) {
        if(this.#isCalibrating) return;
        console.log('INFO: Commax RS485 bridge calibrating...');
        this.#isCalibrating = true;
        this.#chunkBuf = Buffer.concat([...invalid_packets.map(x=>x.raw), this.#chunkBuf]);

        const calibrate_check = () => {
            if(this.#chunkBuf.length < 16) {
                return setTimeout(calibrate_check, 500);
            }

            for(let i = 0 ; i < 8 ; i++) {
                if(!((new Packet(this.#chunkBuf.slice(i, i+8))) instanceof InvalidPacket)) {
                    console.log(`INFO: Commax RS485 bridge calibrated. offset=${i}`);
                    this.#chunkBuf = this.#chunkBuf.slice(i);
                    this.#isCalibrating = false;
                    return;
                }
            }
        };
        calibrate_check();
    }

    #onError() {
        console.log(arguments);
    }

    #onOpen() {
        console.log('INFO: Commax RS485 bridge online.');
    }

    #onClose() {
        if(!this.#isPeacefulClose) {
            console.warn(`WARN: Unexpected close. Try reconnecting after ${RETRY_AFTER} secs.`);
            setTimeout(()=>{
                this.serial.open();
            }, RETRY_AFTER*1000);
        }
        this.#chunkBuf = null;
        this.#isPeacefulClose = false;
        console.log('INFO: Commax RS485 bridge connection lost.');
    }

    #onData(chunk) {
        let currentChunk;
        if(!this.#chunkBuf) {
            this.#chunkBuf = chunk;
        }
        else {
            this.#chunkBuf = Buffer.concat([this.#chunkBuf, chunk]);
        }
        if(this.#isCalibrating) return;

        while(this.#chunkBuf.length >= 8) {
            currentChunk = this.#chunkBuf.slice(0, 8);
            this.#chunkBuf = this.#chunkBuf.slice(8);

            if(!currentChunk) {
                this.#publishQueueEmit();
                return;
            }
            const packet = new Packet(currentChunk);
            this.emit('data', packet);
        }
        this.#publishQueueEmit();
    }

    #publishQueueEmit() {
        if(this.#publishQueueLock || this.#chunkBuf.length) return;
        this.#publishQueueLock = true;
        let packet = null;
        while(packet = this.#publishQueue.shift()) {
            console.log('rs485 sent', packet.message);
            if(!this.serial.write(packet.message, undefined, packet.callback)) {
                console.log('rs485 publish failed!', packet.message);
                this.#publishQueue.unshift(packet);
            }
        }
        this.#publishQueueLock = false;
    }
}

export default Listener;
