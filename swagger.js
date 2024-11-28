import swaggerJsdoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Plate Vista API",
      version: "1.0.0",
      description: "Restaurant Management System API documentation",
    },
    servers: [
      {
        url: process.env.PRODUCTION_URL || "http://localhost:8080",
        description: "Production server",
      },
      {
        url: "http://localhost:8080",
        description: "Development server",
      },
      {
        url: "ws://localhost:8080/ws",
        description: "WebSocket server",
      },
    ],
    components: {
      parameters: {
        restaurantHeader: {
          in: "header",
          name: "x-restaurant-id",
          required: true,
          schema: {
            type: "string",
          },
          description: "Restaurant identifier",
        },
      },
      schemas: {
        MenuItem: {
          type: "object",
          properties: {
            title: { type: "string", example: "Chicken Burger" },
            description: {
              type: "string",
              example: "Delicious chicken burger",
            },
            price: { type: "number", example: 14.99 },
            image: {
              type: "string",
              example: "https://cloudinary.com/image.jpg",
            },
            category: { type: "string", example: "burgers" },
            popular: { type: "boolean", example: false },
            numSold: { type: "number", example: 0 },
            inStock: { type: "boolean", example: true },
          },
        },
        Restaurant: {
          type: "object",
          properties: {
            restaurantName: { type: "string", example: "Tasty Bites" },
            email: { type: "string", example: "contact@tastybites.com" },
            password: { type: "string", example: "password123" },
          },
        },
        Order: {
          type: "object",
          properties: {
            menuItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  product: { type: "string" },
                  quantity: { type: "number" },
                },
              },
            },
            totalPrice: { type: "number" },
            status: { type: "string" },
            table: { type: "string" },
          },
        },
        Employee: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            role: { type: "string" },
            password: { type: "string" },
          },
        },
        Table: {
          type: "object",
          properties: {
            tableNumber: { type: "number" },
            capacity: { type: "number" },
            isOccupied: { type: "boolean" },
          },
        },
        User: {
          type: "object",
          properties: {
            name: { type: "string", example: "John Doe" },
            email: { type: "string", example: "john@example.com" },
            password: { type: "string", example: "password123" },
            role: { type: "string", example: "customer" },
          },
        },
        Statistics: {
          type: "object",
          properties: {
            totalSales: { type: "number", example: 1250.5 },
            orderCount: { type: "number", example: 45 },
            averageOrderValue: { type: "number", example: 27.79 },
            startDate: { type: "string", format: "date" },
            endDate: { type: "string", format: "date" },
          },
        },
        WebSocketMessage: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "CREATE_ORDER",
                "UPDATE_ORDER",
                "CHANGE_STATUS",
                "CONNECT_TABLE",
                "DISCONNECT_TABLE",
              ],
              example: "CREATE_ORDER",
            },
            payload: {
              type: "object",
              properties: {
                tableNum: { type: "number", example: 1 },
                userId: { type: "string", example: "user123" },
                order: { $ref: "#/components/schemas/Order" },
              },
            },
          },
        },
        Error: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
        },
      },
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    paths: {
      "/ws": {
        get: {
          tags: ["WebSocket"],
          summary: "WebSocket connection endpoint",
          description: `
            WebSocket endpoint for real-time order updates.
            
            ## Connection
            \`\`\`javascript
            const ws = new WebSocket('ws://localhost:8080/ws?restaurantId=123&tableNum=1&userId=user123');
            \`\`\`

            ## Query Parameters
            - restaurantId: Restaurant identifier
            - tableNum: Table number (optional)
            - userId: User identifier (optional)

            ## Message Types
            1. newOrder
            \`\`\`json
            {
              "type": "newOrder",
              "payload": {
                "menuItems": [
                  {
                    "product": "productId",
                    "quantity": 2
                  }
                ]
              }
            }
            \`\`\`

            2. updateOrder
            \`\`\`json
            {
              "type": "updateOrder",
              "payload": {
                "orderId": "orderId",
                "updates": {
                  "status": "preparing"
                }
              }
            }
            \`\`\`

            3. changeStatus
            \`\`\`json
            {
              "type": "changeStatus",
              "payload": {
                "orderId": "orderId",
                "status": "ready"
              }
            }
            \`\`\`
          `,
          parameters: [
            {
              in: "query",
              name: "restaurantId",
              required: true,
              schema: {
                type: "string",
              },
            },
            {
              in: "query",
              name: "tableNum",
              schema: {
                type: "string",
              },
            },
            {
              in: "query",
              name: "userId",
              schema: {
                type: "string",
              },
            },
          ],
          responses: {
            101: {
              description:
                "Switching Protocols - WebSocket connection established",
            },
          },
        },
      },
    },
  },
  apis: ["./routes/*.js"],
};

export const specs = swaggerJsdoc(options);
