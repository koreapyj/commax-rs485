import { Buffer } from 'buffer';
import SerialPort from "serialport";

const RETRY_AFTER = 30;

export class Packet {
    constructor(packet) {
        this.packet = packet;
        this.type = packet[0] & ~0x80;
    }

    check() {
        const checksum = Packet.checksum(this.packet);

        if(this.packet[7] != checksum) {
            throw new TypeError(`Checksum mismatch (should be ${checksum}) at packet ${this.packet.toString('hex')}`);
        }
    }

    static checksum(packet) {
        let checksum = 0;
        for(let i = 0 ; i < 7 ; i++) {
            checksum += packet[i];
        }
        checksum = checksum & 0xff;
        return checksum;
    }

    static from(packet) {
        this.checksum(packet);

        const isReply = packet[0] & 0x80;
        const type = packet[0] & ~0x80;

        if(!isReply) {
            return new QueryPacket(packet);
        }

        switch(type) {
            case 0x02: /* 보일러 */
                return new ThermostatReplyPacket(packet);
            case 0x30: /* 조명 */
                return new LightReplyPacket(packet);
            case 0x20: /* 일괄소등 스위치 */
                return new SwitchReplyPacket(packet);
            case 0x76: /* 전열교환기 */
                return new FanReplyPacket(packet);
            case 0x79: /* 대기전력차단스위치 */
                if(packet[3] === 0x10) return new OutletEnergyMeterReplyPacket(packet);
                if(packet[3] === 0x20) return new OutletReplyPacket(packet);
            default:
        }
        return new UnknownPacket(packet);
    }
}

class UnknownPacket extends Packet {
}

class QueryPacket extends Packet {
    constructor(packet) {
        super(packet);
        this.id = packet[2];
    }
}

class ReplyPacket extends Packet {
    constructor(packet) {
        super(packet);
        this.id = packet[2];
    }
}

class FanReplyPacket extends ReplyPacket {
    constructor(packet) {
        super(packet);

        this.on = ~~packet[1];
        this.currentFanSpeedSetting = {0x1: 'speed_low', 0x2: 'speed_middle', 0x3: 'speed_high'}[packet[3]];
        this.currentModeSetting = {0x2: 'auto', 0x4: 'manual', 0x6: 'sleep', 0x7: 'supply', 0x8: 'heat'}[packet[1]];
        this.timerRemainingSec = packet[4] ? (packet[5]*60+packet[6])*60 : -1;
    }
}

class ThermostatReplyPacket extends ReplyPacket {
    constructor(packet) {
        super(packet);

        this.thermostatMode = {0x81: 'HEAT', 0x84: 'OFF'}[packet[1]] || `unknown(${packet[1]})`;
        this.thermostatTemperatureAmbient = ~~packet[3].toString(16);
        this.thermostatTemperatureSetpoint = ~~packet[4].toString(16);
    }
}

class OutletReplyPacket extends ReplyPacket {
    constructor(packet) {
        super(packet);

        this.on = !!(packet[1] & 0xf);
        this.currentModeSetting = {0x10: 'auto', 0x0: 'manual'}[packet[1] & 0xf0];
        this.threshold = ~~packet[6].toString(16);
    }
}

class SwitchReplyPacket extends ReplyPacket {
    constructor(packet) {
        super(packet);

        this.on = !!packet[1];
    }
}

class LightReplyPacket extends SwitchReplyPacket {
}

class SensorReplyPacket extends ReplyPacket {
}

class OutletEnergyMeterReplyPacket extends SensorReplyPacket {
    constructor(packet) {
        super(packet);
        this.energyUsage = ~~packet.slice(4,5).toString('hex');
    }
}

export class Parser {
    #chunkBuf
    #isPeacefulClose

    constructor(port) {
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

    shutdown(cb) {
        if(this.online) {
            console.log('INFO: Commax RS485 bridge shutting down...');
            this.#isPeacefulClose = true;
            this.serial.close(cb);
        }
        else return cb();
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
        if(this.#chunkBuf.length >= 8) {
            currentChunk = this.#chunkBuf.slice(0, 8);
            this.#chunkBuf = this.#chunkBuf.slice(8);
        }
        if(!currentChunk) return;

        const packet = Packet.from(currentChunk);

        if(!(packet instanceof UnknownPacket) && !(packet instanceof QueryPacket)) console.log(packet);
    }
}

export default Parser;
