import Table from "../models/table.model.js";
import { generateTableToken, verifyToken } from "../utils/index.js";

export const login = (req, res) => {
  const { user } = req;
  if (user.username) {
    return res
      .status(200)
      .json({ message: "Logged in successfully", username: user.username });
  }
  return res
    .status(200)
    .json({ message: "Logged in successfully", position: user.position });
};

export const authenticateWithToken = (req, res) => {
  const { user } = req;
  res.status(200).json({ user });
};

// Public: issues a short-lived, table-scoped token a guest (or an
// identified logged-in user, via an optional Authorization header) uses
// to open a WebSocket connection for that table only.
export const issueTableToken = async (req, res) => {
  const { tableNumber } = req.params;
  if (!/^\d+$/.test(tableNumber) || Number(tableNumber) <= 0) {
    return res.status(400).json({ message: "Invalid table number" });
  }

  try {
    const table = await Table.findOne({ tableNumber: Number(tableNumber) });
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    let identity;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const decoded = verifyToken(authHeader.split(" ")[1]);
        if (decoded.role === "user") {
          identity = { _id: decoded.id };
        }
      } catch (error) {
        // Ignore an invalid/expired login token: fall back to an anonymous guest.
      }
    }

    const token = generateTableToken(tableNumber, identity);
    res.status(200).json({ token });
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};
