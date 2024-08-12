export const login = (req, res) => {
  res.status(200).json({ message: "Logged in successfully" });
};
export const authenticateWithToken = (req, res) => {
  const { user } = req;
  res.status(200).json({ user });
};
