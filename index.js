import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import connectToDatabase from "./db/db.js";
import userRouter from "./routes/userRouter.js";
const app = express();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Plate Vista API");
});
app.use('/api/v1/users', userRouter);

await connectToDatabase();
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
