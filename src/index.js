import Koa from 'koa';
import {posix as Path} from 'path';
import router from './routes.js';
import * as CommaxRs485 from "./lib/CommaxRs485.js";

const app = new Koa;

app.use(router.routes());
app.use(router.allowedMethods());

(async () => {
    {
        const port = process.env.COMMAX_SERIAL_PORT;
        console.log(`TARGET=${port}`);
        app.context.RS485 = new CommaxRs485.Parser(port);

        const shutdown = () => {
            app.context.RS485.shutdown(()=>{
                process.exit(0);
            });
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    }

    const server = app.listen(process.env.PORT, () => {
        console.log(`commax-rs485 is listening on port ${server.address().port}`);
    });
})();
