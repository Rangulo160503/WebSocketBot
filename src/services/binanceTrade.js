import axios from "axios";

const BASE_URL = "http://localhost:3000";

export async function placeOrder({ symbol, side, quantity, type = "MARKET", price = null }) {
  const res = await axios.post(`${BASE_URL}/order`, {
    symbol,
    side,
    quantity,
    type,
    price,
  });
  return res.data;
}

export async function getBalances() {
  const res = await axios.get(`${BASE_URL}/balance`);
  return res.data;
}
