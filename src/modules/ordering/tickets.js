import { STATIONS } from "../categories/category.model.js";
import { ORDER_STATUSES } from "./order.transitions.js";

// An order has one ticket for each station its lines go to, and each ticket
// has its own status (docs/adr/0002-one-order-with-a-ticket-per-station.md).

export const stationOf = (line) => line.station || "kitchen";

export const buildTickets = (items, status = "pending", cancelReason = "") =>
  STATIONS.filter((station) => items.some((line) => stationOf(line) === station)).map(
    (station) => ({ station, status, cancelReason })
  );

// Orders saved before tickets existed had one status for every line.
export const ticketsOf = (order) => {
  if (order.tickets?.length) {
    return order.tickets.map((ticket) => ({
      station: ticket.station,
      status: ticket.status,
      cancelReason: ticket.cancelReason || "",
    }));
  }
  const status = ORDER_STATUSES.includes(order.status) ? order.status : "pending";
  return buildTickets(order.items || [], status, order.cancelReason || "");
};

const isActive = (ticket) => ticket.status !== "cancelled";

// An order is only as far along as its slowest ticket that is still being
// worked, and is cancelled only when every ticket is.
export const orderStatusOf = (tickets) => {
  const active = tickets.filter(isActive);
  if (active.length === 0) return "cancelled";
  return active
    .map((ticket) => ticket.status)
    .reduce((slowest, status) =>
      ORDER_STATUSES.indexOf(status) < ORDER_STATUSES.indexOf(slowest) ? status : slowest
    );
};

// Lines of a cancelled ticket come off the total. A fully cancelled order
// keeps the total of what was cancelled.
export const orderTotalCents = (items, tickets) => {
  const active = new Set(tickets.filter(isActive).map((ticket) => ticket.station));
  const counted = active.size === 0 ? items : items.filter((line) => active.has(stationOf(line)));
  return counted.reduce((sum, line) => sum + line.lineTotalCents, 0);
};

// What to store after the tickets changed: the tickets, each line's copy of
// its ticket's status, and the order's own status and total.
export const ticketFields = (order, tickets) => {
  const statusAt = new Map(tickets.map((ticket) => [ticket.station, ticket.status]));
  const items = order.items.map((line) => ({
    ...(line.toObject ? line.toObject() : line),
    status: statusAt.get(stationOf(line)),
  }));
  return {
    tickets,
    items,
    status: orderStatusOf(tickets),
    totalCents: orderTotalCents(items, tickets),
  };
};
