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
        url: "http://localhost:8080/api/v1",
        description: "Development server",
      },
    ],
    components: {
      schemas: {
        MenuItem: {
          type: "object",
          properties: {
            title: { type: "string", example: "Chicken Burger" },
            description: {
              type: "string",
              example: "Delicious chicken burger with special sauce",
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
          required: ["title", "description", "price", "image", "category"],
        },
        Error: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
        },
      },
    },
  },
  apis: ["./routes/*.js"], // Path to the API routes
};

export const specs = swaggerJsdoc(options);
