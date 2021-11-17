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
        if(!process.env.MQTT_PREFIX) return topic;
        return `${process.env.MQTT_PREFIX}/${topic}`;
    }

    static removePrefix(topic) {
        if(!process.env.MQTT_PREFIX || !topic.startsWith(process.env.MQTT_PREFIX)) return topic;
        return topic.substr(process.env.MQTT_PREFIX.length);
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
            clientId: process.env.MQTT_CLIENT_ID || process.env.MQTT_PREFIX || 'commaxrs485bridge',
            username: process.env.MQTT_USER,
            password: process.env.MQTT_PASSWORD
        });
        ctx.MQTT._subscribes = new MQTTSubscribeSet(ctx.MQTT);
    }

    {
        /* suppress log messages on prod */
        if(!process.env.DEBUG) {
            console.log = function(){};
        }
    }

    {
        const port = process.env.SERIAL_PORT;
        let invalid_packets = [];
        console.log(`TARGET=${port}`);
        ctx.RS485 = new CommaxRs485.Listener({port});
        ctx.RS485.on('data', (packet) => {
            const mqtt_packets = [];
            const object_id = `${packet.constructor.name.replace(/ReplyPacket$/,'').toLowerCase()}-${packet.id}`;
            switch(packet.constructor.name) {
                case 'TimePacket':
                    break;
                case 'RequestPacket':
                    if(packet.raw.slice(3,7).toString('hex') === '00000000' && (packet.raw[0] === 0x79 || !packet.raw[2])) {
                        break;
                    }
                case 'ReplyPacket':
                    if([0x8f, 0xf7].includes(packet.raw[0])) break;
                    break;
                case 'FanReplyPacket':
                    {
                        ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`fan/${object_id}/switch`), (_, message) => {
                            const {id} = packet;
                            const value = message.toString();
                            ctx.RS485.publish(new CommaxRs485.FanRequestPacket({
                                id,
                                name: 'state',
                                value: value === 'ON',
                                current: packet,
                            }))
                        });
                        ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`fan/${object_id}/mode`), (_, message) => {
                            const {id} = packet;
                            const value = message.toString();
                            ctx.RS485.publish(new CommaxRs485.FanRequestPacket({
                                id,
                                name: 'mode',
                                value,
                                current: packet,
                            }))
                        });
                        ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`fan/${object_id}/speed`), (_, message) => {
                            const {id} = packet;
                            const value = ~~message.toString();
                            ctx.RS485.publish(new CommaxRs485.FanRequestPacket({
                                id,
                                name: 'speed',
                                value,
                                current: packet,
                            }))
                        });
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
                                    state: speed > 0 ? 'ON' : 'OFF',
                                    speed: speed.toString(),
                                }
                            ),
                            new MQTTOutgoingPacket(
                                `fan/${object_id}/config`,
                                {
                                    name: object_id,
                                    unique_id: object_id,
                                    cmd_t: MQTTPacket.appendPrefix(`fan/${object_id}/switch`),
                                    stat_t: MQTTPacket.appendPrefix(`fan/${object_id}`),
                                    stat_val_tpl: "{{ value_json.state }}",
                                    pct_stat_t: MQTTPacket.appendPrefix(`fan/${object_id}`),
                                    pct_val_tpl: "{{ value_json.speed }}",
                                    pct_cmd_t: MQTTPacket.appendPrefix(`fan/${object_id}/speed`),
                                    pr_mode_stat_t: MQTTPacket.appendPrefix(`fan/${object_id}`),
                                    pr_mode_val_tpl: "{{ value_json.mode }}",
                                    pr_mode_cmd_t: MQTTPacket.appendPrefix(`fan/${object_id}/mode`),
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
                        ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`climate/${object_id}/mode`), (_, message) => {
                            const {id} = packet;
                            const value = message.toString();
                            ctx.RS485.publish(new CommaxRs485.ThermostatRequestPacket({
                                id,
                                name: 'mode',
                                value,
                                current: packet,
                            }))
                        });
                        ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`climate/${object_id}/away`), (_, message) => {
                            const {id} = packet;
                            const value = message.toString();
                            ctx.RS485.publish(new CommaxRs485.ThermostatRequestPacket({
                                id,
                                name: 'away',
                                value: value === 'ON',
                                current: packet,
                            }))
                        });
                        ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`climate/${object_id}/temp`), (_, message) => {
                            const {id} = packet;
                            const value = message.toString();
                            ctx.RS485.publish(new CommaxRs485.ThermostatRequestPacket({
                                id,
                                name: 'temp',
                                value: ~~value,
                                current: packet,
                            }))
                        });
                        mqtt_packets.push(
                            new MQTTOutgoingPacket(
                                `climate/${object_id}`,
                                {
                                    state: packet.state.toLowerCase() !== 'off' ? 'ON' : 'OFF',
                                    mode: packet.state.toLowerCase() !== 'off' ? 'heat' : 'off',
                                    away: packet.state.toLowerCase() === 'away' ? 'ON' : 'OFF',
                                    target_temp: packet.thermostatTemperatureSetpoint.toString() + '.0',
                                    current_temp: packet.thermostatTemperatureAmbient.toString() + '.0',
                                }
                            ),
                            new MQTTOutgoingPacket(
                                `sensor/${object_id}`,
                                packet.thermostatTemperatureAmbient.toString(),
                            ),
                            new MQTTOutgoingPacket(
                                `climate/${object_id}/config`,
                                {
                                    name: object_id,
                                    unique_id: object_id,
                                    stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    val_tpl: "{{ value_json.state }}",
                                    curr_temp_stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    curr_temp_tpl: "{{ value_json.current_temp | float }}",
                                    unit_of_meas: "°C",
                                    temp_stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    temp_stat_tpl: "{{ value_json.target_temp }}",
                                    temp_cmd_t: MQTTPacket.appendPrefix(`climate/${object_id}/temp`),
                                    mode_stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    mode_cmd_t: MQTTPacket.appendPrefix(`climate/${object_id}/mode`),
                                    mode_stat_tpl: "{{ value_json.mode }}",
                                    away_mode_stat_t: MQTTPacket.appendPrefix(`climate/${object_id}`),
                                    away_mode_cmd_t: MQTTPacket.appendPrefix(`climate/${object_id}/away`),
                                    away_mode_stat_tpl: "{{ value_json.away }}",
                                    min_temp: "5",
                                    max_temp: "40",
                                    temp_step: "1",
                                    modes: [
                                        'off',
                                        'heat',
                                    ],
                                }
                            ),
                            new MQTTOutgoingPacket(
                                `sensor/${object_id}/config`,
                                {
                                    name: object_id,
                                    uniq_id: object_id,
                                    dev_cla: 'temperature',
                                    stat_cla: 'measurement',
                                    stat_t: MQTTPacket.appendPrefix(`sensor/${object_id}`),
                                    unit_of_meas: '°C',
                                }
                            ),
                        );
                    }
                    break;
                case 'OutletEnergyMeterReplyPacket':
                    mqtt_packets.push(
                        new MQTTOutgoingPacket(
                            `sensor/outlet-${packet.id}`,
                            packet.energyUsage.toString()
                        ),
                        new MQTTOutgoingPacket(
                            `sensor/outlet-${packet.id}/config`,
                            {
                                name: `outlet-${packet.id}`,
                                uniq_id: `outlet-${packet.id}`,
                                dev_cla: 'power',
                                stat_cla: 'measurement',
                                stat_t: MQTTPacket.appendPrefix(`sensor/outlet-${packet.id}`),
                                unit_of_meas: 'W',
                            }
                        ),
                    );
                    break;
                case 'OutletReplyPacket':
                    ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`switch/${object_id}/switch`), (_, message) => {
                        const {id} = packet;
                        const value = message.toString();
                        ctx.RS485.publish(new CommaxRs485.OutletRequestPacket({
                            id,
                            name: 'state',
                            value: value === 'ON',
                        }))
                    });
                    ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`switch/${object_id}/select`), (_, message) => {
                        const {id} = packet;
                        const value = message.toString();
                        ctx.RS485.publish(new CommaxRs485.OutletRequestPacket({
                            id,
                            name: 'mode',
                            value,
                        }))
                    });
                    ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`switch/${object_id}/number`), (_, message) => {
                        const {id} = packet;
                        const value = ~~message.toString();
                        ctx.RS485.publish(new CommaxRs485.OutletRequestPacket({
                            id,
                            name: 'threshold',
                            value,
                        }))
                    });
                    const threshold = ~~packet.threshold;
                    mqtt_packets.push(
                        new MQTTOutgoingPacket(
                            `switch/${object_id}`,
                            {
                                state: packet.state ? 'ON' : 'OFF',
                                mode: packet.currentModeSetting,
                                threshold
                            }
                        ),
                        new MQTTOutgoingPacket(
                            `switch/${object_id}/config`,
                            {
                                name: object_id,
                                uniq_id: object_id,
                                dev_cla: 'outlet',
                                cmd_t: MQTTPacket.appendPrefix(`switch/${object_id}/switch`),
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
                                icon: 'mdi:power-plug-off',
                                cmd_t: MQTTPacket.appendPrefix(`switch/${object_id}/select`),
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
                                icon: 'mdi:power-plug-off',
                                cmd_t: MQTTPacket.appendPrefix(`switch/${object_id}/number`),
                                stat_t: MQTTPacket.appendPrefix(`switch/${object_id}`),
                                val_tpl: "{{ value_json.threshold }}",
                                min: 0,
                                max: 3000,
                                step: 1,
                                unit_of_meas: 'W',
                            }
                        ),
                    );
                    break;
                case 'SwitchReplyPacket':
                    ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`switch/${object_id}/switch`), (_, message) => {
                        const {id} = packet;
                        const value = message.toString();
                        ctx.RS485.publish(new CommaxRs485.SwitchRequestPacket({
                            id,
                            name: 'state',
                            value: value === 'ON',
                        }))
                    });
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
                                cmd_t: MQTTPacket.appendPrefix(`switch/${object_id}/switch`),
                                stat_t: MQTTPacket.appendPrefix(`switch/${object_id}`),
                            }
                        ),
                    );
                    break;
                case 'LightReplyPacket':
                    ctx.MQTT._subscribes.add(MQTTPacket.appendPrefix(`light/${object_id}/switch`), (_, message) => {
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
            }
            if(packet.constructor.name === 'InvalidPacket') {
                invalid_packets.push(packet);
                if(invalid_packets.length > 1) {
                    ctx.RS485.calibrate(invalid_packets);
                    invalid_packets = [];
                }
                if(invalid_packets.length) console.warn('WARN: Invalid packet.');
            }
            else {
                invalid_packets = [];
            }
            if(mqtt_packets.length) {
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
