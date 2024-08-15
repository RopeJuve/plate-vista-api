export const login = (req, res) => {
  const { user } = req;
  res
    .status(200)
    .json({ message: "Logged in successfully", username: user.username });
};
export const authenticateWithToken = (req, res) => {
  const { user } = req;
  res.status(200).json({ user });
};
