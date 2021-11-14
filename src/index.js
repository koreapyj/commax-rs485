import * as CommaxRs485 from "./lib/CommaxRs485.js";
import MQTT from "mqtt";

const ctx = {};

class MQTTPacket {
    constructor(topic, payload) {
        this.payload = typeof payload === 'object' ? JSON.stringify(payload) : payload.toString();
    }

    toJSON() {
        return this.payload;
    }

    toString() {
        return this.payload;
    }

    static appendPrefix(topic) {
        if(!process.env.COMMAX_MQTT_PREFIX) return topic;
        return `${process.env.COMMAX_MQTT_PREFIX}/${topic}`;
    }

    static removePrefix(topic) {
        if(!process.env.COMMAX_MQTT_PREFIX || !topic.startsWith(process.env.COMMAX_MQTT_PREFIX)) return topic;
        return topic.substr(process.env.COMMAX_MQTT_PREFIX.length);
    }
}

class MQTTIncomingPacket extends MQTTPacket {
    constructor(topic, payload) {
        super(topic, payload);
        this.topic = MQTTPacket.removePrefix(topic);
    }
}

class MQTTOutgoingPacket extends MQTTPacket {
    constructor(topic, payload) {
        super(topic, payload);
        this.topic = MQTTPacket.appendPrefix(topic);
    }
}

class MQTTSubscribeSet extends Set {
    mqtt = null;
    callbacks = {};

    constructor(mqtt) {
        super();
        this.mqtt = mqtt;
        this.mqtt.on('message', (topic, message) => {
            this.callbacks[topic](topic, message);
        });
    }

    add(topic, callback) {
        if(this.has(topic)) return;
        super.add(topic);
        this.mqtt.subscribe(topic);
        this.callbacks[topic] = callback;
    }
}

(async () => {
    {
        ctx.MQTT = MQTT.connect('mqtt://localhost', {
            clientId: process.env.COMMAX_MQTT_CLIENT_ID || process.env.COMMAX_MQTT_PREFIX || 'commaxrs485bridge',
            username: process.env.COMMAX_MQTT_USER,
            password: process.env.COMMAX_MQTT_PASSWORD
        });
        ctx.MQTT._subscribes = new MQTTSubscribeSet(ctx.MQTT);
    }

    {
        const port = process.env.COMMAX_SERIAL_PORT;
        let invalid_packets = [];
        console.log(`TARGET=${port}`);
        ctx.RS485 = new CommaxRs485.Listener({port});
        ctx.RS485.on('data', (packet) => {
            if(packet.ack) {
                ctx.RS485.freePending(Buffer.from([packet.raw[0] & 0x80, packet.raw[2]]));
            }
            const mqtt_packets = [];
            const object_id = `${packet.constructor.name.replace(/ReplyPacket$/,'').toLowerCase()}-${packet.id}`;
            switch(packet.constructor.name) {
                case 'TimePacket':
                    break;
                case 'RequestPacket':
                    console.log(packet);
                    if(packet.raw.slice(3,7).toString('hex') === '00000000' && (packet.raw[0] === 0x79 || !packet.raw[2])) {
                        break;
                    }
                case 'ReplyPacket':
                    if([0x8f, 0xf7].includes(packet.raw[0])) break;
                    // console.log(packet, packet.raw.toString('hex'));
                    break;
                case 'FanReplyPacket':
                    {
                        const speed = [
                            'speed_off',
                            'speed_low',
                            'speed_middle',
                            'speed_high',
                        ].indexOf(packet.currentFanSpeedSetting);
                        mqtt_packets.push(
                            new MQTTOutgoingPacket(
                                `fan/${object_id}`,
                                {
                                    mode: packet.state,
                                    state: packet.state !== 'off' ? 'ON' : 'OFF',
                                    speed: speed.toString(),
                                }
                            ),
                            new MQTTOutgoingPacket(
                                `fan/${object_id}/config`,
                                {
                                    name: object_id,
                                    unique_id: object_id,
                                    cmd_t: MQTTPacket.appendPrefix(`fan/${object_id}/set`),
                                    stat_t: MQTTPacket.appendPrefix(`fan/${object_id}`),
                                    stat_val_tpl: "{{ value_json.state }}",
                                    pct_stat_t: MQTTPacket.appendPrefix(`fan/${object_id}`),
                                    pct_val_tpl: "{{ value_json.speed }}",
                                    pct_cmd_t: MQTTPacket.appendPrefix(`fan/${object_id}/set`),
                                    pr_mode_stat_t: MQTTPacket.appendPrefix(`fan/${object_id}`),
                                    pr_mode_val_tpl: "{{ value_json.mode }}",
                                    pr_mode_cmd_t: MQTTPacket.appendPrefix(`fan/${object_id}/set`),
                                    spd_rng_min: 1,
                                    spd_rng_max: 3,
                                    pr_modes: [
                                        'auto',
                                        'manual',
                                        'sleep',
                                        'supply',
                                        'heat',
                                    ]
                                }
                            ),
                        );
                    }
                    break;
                case 'ThermostatReplyPacket':
                    {
                        mqtt_packets.push(
                            new MQTTOutgoingPacket(
                                `climate/${object_id}`,
                                {
                                    state: packet.state.toLowerCase() !== 'off' ? 'ON' : 'OFF',
                                    mode: packet.state.toLowerCase(),
                                    target_temp: packet.thermostatTemperatureSetpoint.toString(),
                                    current_temp: packet.thermostatTemperatureAmbient.toString(),
                                }
                            ),
                            new MQTTOutgoingPacket(
                                `climate/${object_id}/config`,
                                {
                                    name: object_id,
                                    unique_id: object_id,
                                    stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    val_tpl: "{{ value_json.state }}",
                                    cmd_t: MQTTPacket.appendPrefix(`climate/${object_id}/set`),
                                    curr_temp_stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    curr_temp_tpl: "{{ value_json.current_temp }}",
                                    temp_stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    temp_stat_tpl: "{{ value_json.target_temp }}",
                                    temp_cmd_t: MQTTPacket.appendPrefix(`climate/${object_id}/set`),
                                    mode_stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    mode_cmd_t: MQTTPacket.appendPrefix(`climate/${object_id}/set`),
                                    mode_stat_tpl: "{{ value_json.mode }}",
                                    away_mode_cmd_t: MQTTPacket.appendPrefix(`climate/${object_id}/set`),
                                    min_temp: "5",
                                    max_temp: "40",
                                    temp_step: "1",
                                    unit_of_meas: "°C",
                                    modes: [
                                        'off',
                                        'heat',
                                    ],
                                }
                            ),
                        );
                    }
                    break;
                case 'OutletEnergyMeterReplyPacket':
                    console.log(packet);
                    mqtt_packets.push(
                        new MQTTOutgoingPacket(
                            `sensor/outlet-${packet.id}`,
                            packet.energyUsage.toString()
                        ),
                        new MQTTOutgoingPacket(
                            `sensor/outlet-${packet.id}/config`,
                            {
                                name: object_id,
                                uniq_id: object_id,
                                dev_cla: 'power',
                                stat_cla: 'measurement',
                                stat_t: MQTTPacket.appendPrefix(`sensor/outlet-${packet.id}`),
                                unit_of_meas: 'W',
                            }
                        ),
                    );
                    break;
                case 'OutletReplyPacket':
                    mqtt_packets.push(
                        new MQTTOutgoingPacket(
                            `switch/${object_id}`,
                            {
                                state: packet.state ? 'ON' : 'OFF',
                                mode: packet.currentModeSetting,
                                threshold: packet.threshold
                            }
                        ),
                        new MQTTOutgoingPacket(
                            `switch/${object_id}/state`,
                            {
                                state: packet.state ? 'ON' : 'OFF',
                                mode: packet.currentModeSetting,
                                threshold: packet.threshold
                            }
                        ),
                        new MQTTOutgoingPacket(
                            `switch/${object_id}/config`,
                            {
                                name: object_id,
                                uniq_id: object_id,
                                dev_cla: 'outlet',
                                cmd_t: MQTTPacket.appendPrefix(`switch/${object_id}/set`),
                                stat_t: MQTTPacket.appendPrefix(`switch/${object_id}`),
                                val_tpl: "{{ value_json.state }}",
                            }
                        ),
                        new MQTTOutgoingPacket(
                            `select/${object_id}/config`,
                            {
                                name: object_id,
                                uniq_id: object_id,
                                dev_cla: 'outlet',
                                icon: 'power-plug-off',
                                cmd_t: MQTTPacket.appendPrefix(`select/${object_id}/set`),
                                stat_t: MQTTPacket.appendPrefix(`switch/${object_id}`),
                                val_tpl: "{{ value_json.mode }}",
                                options: [
                                    'auto',
                                    'manual',
                                ],
                            }
                        ),
                        new MQTTOutgoingPacket(
                            `number/${object_id}/config`,
                            {
                                name: object_id,
                                uniq_id: object_id,
                                dev_cla: 'outlet',
                                icon: 'power-plug-off',
                                cmd_t: MQTTPacket.appendPrefix(`number/${object_id}/set`),
                                stat_t: MQTTPacket.appendPrefix(`switch/${object_id}`),
                                val_tpl: "{{ value_json.threshold }}",
                                min: 0,
                                max: 100,
                                unit_of_meas: 'W',
                            }
                        ),
                    );
                    break;
                case 'SwitchReplyPacket':
                    mqtt_packets.push(
                        new MQTTOutgoingPacket(
                            `switch/${object_id}`,
                            packet.state ? 'ON' : 'OFF'
                        ),
                        new MQTTOutgoingPacket(
                            `switch/${object_id}/config`,
                            {
                                name: object_id,
                                uniq_id: object_id,
                                dev_cla: 'switch',
                                cmd_t: MQTTPacket.appendPrefix(`switch/${object_id}/set`),
                                stat_t: MQTTPacket.appendPrefix(`switch/${object_id}`),
                            }
                        ),
                    );
                    break;
                case 'LightReplyPacket':
                    ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`light/${object_id}/switch`), (_, message) => {
                        console.log('incoming', message.toString('utf8'));
                        const {id} = packet;
                        const value = message.toString();
                        ctx.RS485.publish(new CommaxRs485.LightRequestPacket({
                            id,
                            name: 'state',
                            value: value === 'ON',
                        }))
                    });
                    mqtt_packets.push(
                        new MQTTOutgoingPacket(
                            `light/${object_id}`,
                            packet.state ? 'ON' : 'OFF'
                        ),
                        new MQTTOutgoingPacket(
                            `light/${object_id}/config`,
                            {
                                name: object_id,
                                uniq_id: object_id,
                                cmd_t: MQTTPacket.appendPrefix(`light/${object_id}/switch`),
                                stat_t: MQTTPacket.appendPrefix(`light/${object_id}`),
                            }
                        ),
                    );
                    break;
                default:
                    // console.log(packet);
            }
            if(packet.constructor.name === 'InvalidPacket') {
                invalid_packets.push(packet);
                if(invalid_packets.length > 1) {
                    ctx.RS485.calibrate(invalid_packets);
                    invalid_packets = [];
                }
                console.warn('WARN: Invalid packet.');
            }
            else {
                invalid_packets = [];
            }
            if(mqtt_packets.length) {
                // console.log(mqtt_packets);
                if(ctx.MQTT.connected) {
                    for(const packet of mqtt_packets) {
                        ctx.MQTT.publish(`${packet.topic}`, packet.toString(), {
                            retain: true,
                        });
                    }
                }
                else {
                    console.warn('WARN: MQTT is not ready. Skip.');
                }
            }
        });

        const shutdown = async () => {
            await Promise.all([
                new Promise((resolve,_) => {
                    ctx.RS485.shutdown(resolve);
                }),
                new Promise((resolve,_) => {
                    ctx.MQTT.end(false, {
                        reasonCode: 0x8b,
                    }, resolve);
                }),
            ])
            process.exit(0);
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    }
})();
