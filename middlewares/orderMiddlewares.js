export const checkOrderExists = (_req, res) => {
  res.status(404).json({ message: "Not found" });
};
