const SERVER_URL = process.env.PUBLIC_API_URL || "https://transit-api.tranzor.io";

const ok = (schema: object) => ({
  description: "OK",
  content: { "application/json": { schema } },
});

const errorResponse = {
  description: "Error",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { error: { type: "string" } },
      },
    },
  },
};

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Tranzor Energy API",
    version: "1.0.0",
    description:
      "API для покупки делегирования энергии TRON.\n\n" +
      "У каждого клиента есть депозитный адрес (USDT-TRC20) и баланс. " +
      "Пополните депозитный адрес (минимальная сумма депозита — 500 USDT) — баланс зачисляется, " +
      "после чего можно заказывать энергию на любой TRON-адрес.\n\n" +
      "**Аутентификация:** заголовок `X-API-KEY: <ваш ключ>` в каждом запросе.",
  },
  servers: [{ url: SERVER_URL }],
  tags: [
    { name: "Account", description: "Баланс и депозит" },
    { name: "Energy", description: "Заказы энергии" },
    { name: "Billing", description: "История операций" },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-KEY" },
    },
    schemas: {
      Balance: {
        type: "object",
        properties: {
          balance: { type: "number", example: 500, description: "Баланс в USDT" },
          currency: { type: "string", example: "USDT" },
          depositAddress: { type: "string", example: "TEWxUUUU9ngJ1PZf7JTsW1javtTiYKnSof" },
          network: { type: "string", example: "tron" },
          minDeposit: { type: "number", example: 500, description: "Минимальная сумма депозита, USDT" },
          status: { type: "string", example: "active" },
        },
      },
      Deposit: {
        type: "object",
        properties: {
          depositAddress: { type: "string", example: "TEWxUUUU9ngJ1PZf7JTsW1javtTiYKnSof" },
          network: { type: "string", example: "tron" },
          currency: { type: "string", example: "USDT" },
          minDeposit: { type: "number", example: 500, description: "Минимальная сумма депозита, USDT" },
        },
      },
      OrderRequest: {
        type: "object",
        required: ["amount", "receiveAddress"],
        properties: {
          duration: {
            type: "string",
            enum: ["1h", "5m"],
            default: "1h",
            description: "Длительность делегирования",
          },
          amount: {
            type: "integer",
            minimum: 61000,
            maximum: 3000000,
            example: 65000,
            description: "Объём энергии",
          },
          receiveAddress: {
            type: "string",
            example: "TYourReceiveAddress000000000000000",
            description: "TRON-адрес получателя энергии",
          },
        },
      },
      OrderResult: {
        type: "object",
        properties: {
          id: { type: "string", example: "123" },
          status: { type: "string", example: "submitted" },
          duration: { type: "string", example: "1h" },
          amount: { type: "integer", example: 65000 },
          receiveAddress: { type: "string" },
          balance: { type: "number", example: 41.52, description: "Остаток баланса, USDT" },
        },
      },
      Order: {
        type: "object",
        properties: {
          id: { type: "integer" },
          ts: { type: "string", format: "date-time" },
          duration: { type: "string" },
          amount: { type: "integer" },
          receiveAddress: { type: "string" },
          status: { type: "string" },
        },
      },
      Transaction: {
        type: "object",
        properties: {
          id: { type: "integer" },
          ts: { type: "string", format: "date-time" },
          type: { type: "string", enum: ["deposit", "charge", "refund", "adjust"] },
          amount: { type: "number", description: "USDT (+ пополнение / − списание)" },
          balance: { type: "number" },
          ref: { type: "string", nullable: true },
          detail: { type: "string", nullable: true },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    "/api/v1/balance": {
      get: {
        tags: ["Account"],
        summary: "Баланс и депозитный адрес",
        responses: { "200": ok({ $ref: "#/components/schemas/Balance" }), "401": errorResponse },
      },
    },
    "/api/v1/deposit": {
      get: {
        tags: ["Account"],
        summary: "Депозитный адрес для пополнения",
        responses: { "200": ok({ $ref: "#/components/schemas/Deposit" }), "401": errorResponse },
      },
    },
    "/api/v1/energy/order": {
      post: {
        tags: ["Energy"],
        summary: "Заказать делегирование энергии",
        description: "Списывает стоимость с баланса и делегирует энергию на указанный адрес.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/OrderRequest" } } },
        },
        responses: {
          "201": ok({ $ref: "#/components/schemas/OrderResult" }),
          "400": errorResponse,
          "402": {
            description: "Недостаточно средств на балансе",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
        },
      },
    },
    "/api/v1/energy/orders": {
      get: {
        tags: ["Energy"],
        summary: "История заказов энергии",
        responses: {
          "200": ok({
            type: "object",
            properties: {
              orders: { type: "array", items: { $ref: "#/components/schemas/Order" } },
              count: { type: "integer" },
            },
          }),
        },
      },
    },
    "/api/v1/energy/orders/{id}": {
      get: {
        tags: ["Energy"],
        summary: "Статус заказа",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": ok({ type: "object", properties: { order: { $ref: "#/components/schemas/Order" } } }),
          "404": errorResponse,
        },
      },
    },
    "/api/v1/transactions": {
      get: {
        tags: ["Billing"],
        summary: "История операций по балансу",
        responses: {
          "200": ok({
            type: "object",
            properties: {
              transactions: { type: "array", items: { $ref: "#/components/schemas/Transaction" } },
              count: { type: "integer" },
            },
          }),
        },
      },
    },
  },
};

export const swaggerHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tranzor Energy API — документация</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body{margin:0}.topbar{display:none}</style>
</head>
<body>
  <div id="swagger"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "/api/openapi.json",
      dom_id: "#swagger",
      deepLinking: true,
      persistAuthorization: true,
    });
  </script>
</body>
</html>`;
