import mongoose from "mongoose";

// A frozen bill once kept its online payment as `onlinePayment`; it now keeps
// the payment in progress as `paymentInProgress` with its `kind`, which was
// always online. A Payment's Stripe details were `online`; they are now
// `card`, for any card payment. Safe to run again: documents already in the
// new shape are left alone. A dry run only counts what it would change.
export const migrateCardPayments = async ({ dryRun = false } = {}) => {
  const db = mongoose.connection.db;
  const sessions = db.collection("tablesessions");
  const payments = db.collection("payments");
  const frozenBills = await sessions.find({ onlinePayment: { $exists: true } }).toArray();
  const legacyPayments = await payments.countDocuments({ online: { $exists: true } });
  if (!dryRun) {
    if (frozenBills.length > 0) {
      await sessions.bulkWrite(
        frozenBills.map((session) => ({
          updateOne: {
            filter: { _id: session._id, onlinePayment: { $exists: true } },
            update: {
              $set: { paymentInProgress: { kind: "online", ...session.onlinePayment } },
              $unset: { onlinePayment: "" },
            },
          },
        }))
      );
    }
    if (legacyPayments > 0) {
      await payments.updateMany({ online: { $exists: true } }, { $rename: { online: "card" } });
    }
  }
  return { dryRun, frozenBills: frozenBills.length, payments: legacyPayments };
};
