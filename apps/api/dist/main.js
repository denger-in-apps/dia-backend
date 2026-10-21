"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const helmet_1 = require("helmet");
const cookie_parser_1 = require("cookie-parser");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.use((0, helmet_1.default)());
    app.use((0, cookie_parser_1.default)());
    app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
    app.enableCors({ origin: true, credentials: true });
    app.enableShutdownHooks();
    const port = process.env.PORT || 3000;
    await app.listen(port);
}
bootstrap();
//# sourceMappingURL=main.js.map