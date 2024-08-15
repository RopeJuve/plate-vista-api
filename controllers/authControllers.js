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
