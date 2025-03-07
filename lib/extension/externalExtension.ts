import * as settings from '../util/settings';
import * as utils from '../util/utils';
import fs from 'fs';
import * as data from './../util/data';
import path from 'path';
import logger from './../util/logger';
// @ts-ignore
import stringify from 'json-stable-stringify-without-jsonify';
import bind from 'bind-decorator';
import ExtensionTS from './extensionts';

const requestRegex = new RegExp(`${settings.get().mqtt.base_topic}/bridge/request/extension/(save|remove)`);

class ExternalExtension extends ExtensionTS {
    private requestLookup: {[s: string]: (message: KeyValue) => MQTTResponse};

    override async start(): Promise<void> {
        this.eventBus.onMQTTMessage(this, this.onMQTTMessage_);
        this.requestLookup = {'save': this.saveExtension, 'remove': this.removeExtension};
        this.loadUserDefinedExtensions();
        await this.publishExtensions();
    }

    private getExtensionsBasePath(): string {
        return data.joinPath('extension');
    }

    private getListOfUserDefinedExtensions(): {name: string, code: string}[] {
        const basePath = this.getExtensionsBasePath();
        if (fs.existsSync(basePath)) {
            return fs.readdirSync(basePath).filter((f) => f.endsWith('.js')).map((fileName) => {
                const extensonFilePath = path.join(basePath, fileName);
                return {'name': fileName, 'code': fs.readFileSync(extensonFilePath, 'utf-8')};
            });
        } else {
            return [];
        }
    }

    @bind private removeExtension(message: KeyValue): MQTTResponse {
        const {name} = message;
        const extensions = this.getListOfUserDefinedExtensions();
        const extensionToBeRemoved = extensions.find((e) => e.name === name);

        if (extensionToBeRemoved) {
            this.enableDisableExtension(false, extensionToBeRemoved.name);
            const basePath = this.getExtensionsBasePath();
            const extensionFilePath = path.join(basePath, path.basename(name));
            fs.unlinkSync(extensionFilePath);
            this.publishExtensions();
            logger.info(`Extension ${name} removed`);
            return utils.getResponse(message, {}, null);
        } else {
            return utils.getResponse(message, {}, `Extension ${name} doesn't exists`);
        }
    }

    @bind private saveExtension(message: KeyValue): MQTTResponse {
        const {name, code} = message;
        const ModuleConstructor = utils.loadModuleFromText(code) as ExternalConverterClass;
        this.loadExtension(ModuleConstructor);
        const basePath = this.getExtensionsBasePath();
        /* istanbul ignore else */
        if (!fs.existsSync(basePath)) {
            fs.mkdirSync(basePath);
        }
        const extensonFilePath = path.join(basePath, path.basename(name));
        fs.writeFileSync(extensonFilePath, code);
        this.publishExtensions();
        logger.info(`Extension ${name} loaded`);
        return utils.getResponse(message, {}, null);
    }

    @bind async onMQTTMessage_(data: EventMQTTMessage): Promise<void> {
        const match = data.topic.match(requestRegex);
        if (match && this.requestLookup[match[1].toLowerCase()]) {
            const message = utils.parseJSON(data.message, data.message) as KeyValue;
            try {
                const response = this.requestLookup[match[1].toLowerCase()](message);
                await this.mqtt.publish(`bridge/response/extension/${match[1]}`, stringify(response));
            } catch (error) {
                logger.error(`Request '${data.topic}' failed with error: '${error.message}'`);
                const response = utils.getResponse(message, {}, error.message);
                await this.mqtt.publish(`bridge/response/extension/${match[1]}`, stringify(response));
            }
        }
    }

    @bind private loadExtension(ConstructorClass: ExternalConverterClass): void {
        this.enableDisableExtension(false, ConstructorClass.name);
        this.addExtension(new ConstructorClass(
            this.zigbee, this.mqtt, this.state, this.publishEntityState, this.eventBus, settings, logger));
    }

    private loadUserDefinedExtensions(): void {
        const extensions = this.getListOfUserDefinedExtensions();
        extensions
            .map(({code}) => utils.loadModuleFromText(code))
            .map(this.loadExtension);
    }

    private async publishExtensions(): Promise<void> {
        const extensions = this.getListOfUserDefinedExtensions();
        // await this.mqtt.publish('bridge/extensions', stringify(extensions), {
        //     retain: true,
        //     qos: 0,
        // }, settings.get().mqtt.base_topic, true);
    }
}

module.exports = ExternalExtension;
