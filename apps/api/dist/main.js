"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const helmet_1 = require("helmet");
const cookieParser = require("cookie-parser");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.use((0, helmet_1.default)({ hsts: process.env.NODE_ENV === 'production' ? undefined : false }));
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
    const corsOrigins = (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    app.enableCors({ origin: corsOrigins, credentials: true });
    if (process.env.TRUST_PROXY === 'true') {
        app.getHttpAdapter().getInstance().set('trust proxy', 1);
    }
    app.enableShutdownHooks();
    const port = process.env.PORT || 3000;
    await app.listen(port);
}
bootstrap();
//# sourceMappingURL=main.js.map