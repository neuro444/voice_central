import { NextRequest } from "next/server";

import { SESSION_COOKIE, verifyAndDecodeSessionToken } from "./auth";

export async function authenticatedDashboardRestaurant(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifyAndDecodeSessionToken(token);
  if (!session) return null;
  const restaurant = session.restaurants[0];
  return restaurant ? { session, restaurant } : null;
}
