import Admin from "../models/admin.js";
import Notification from "../models/notification.js";
import Order from "../models/order.js";

const DEFAULT_INTERVAL_MS = 60 * 1000;
const SLA_MONITOR_INTERVAL_MS = parseInt(
  process.env.SLA_MONITOR_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`,
  10,
);

const BREACHABLE_STATUSES = ["pending", "confirmed", "packed", "out_for_delivery"];

const processSlaBreaches = async () => {
  const now = new Date();
  try {
    const breachedOrders = await Order.find({
      hubFlowEnabled: true,
      status: { $in: BREACHABLE_STATUSES },
      slaDeadlineAt: { $lte: now },
      slaBreached: { $ne: true },
    })
      .select("_id orderId customer slaDeadlineAt status")
      .lean();

    if (!breachedOrders.length) return;

    const ids = breachedOrders.map((o) => o._id);
    await Order.updateMany(
      { _id: { $in: ids } },
      { $set: { slaBreached: true, slaBreachedAt: now } },
    );

    const admins = await Admin.find({}).select("_id").lean();
    const adminIds = admins.map((a) => a?._id).filter(Boolean);

    if (adminIds.length) {
      await Notification.insertMany(
        breachedOrders.flatMap((order) =>
          adminIds.map((adminId) => ({
            recipient: adminId,
            recipientModel: "Admin",
            title: "SLA Breach Alert",
            message: `Order #${order.orderId} breached 3-hour SLA.`,
            type: "order",
            data: {
              orderId: order.orderId,
              mongoOrderId: order._id,
              slaDeadlineAt: order.slaDeadlineAt,
              status: order.status,
              slaBreached: true,
            },
          })),
        ),
        { ordered: false },
      );
    }

    console.warn(
      `[SlaMonitorJob] Marked ${breachedOrders.length} order(s) as SLA breached at ${now.toISOString()}`,
    );
  } catch (error) {
    console.error("[SlaMonitorJob] Error:", error.message);
  }
};

export const startSlaMonitorJob = () => {
  if (globalThis.__SLA_MONITOR_JOB_STARTED__) return;
  globalThis.__SLA_MONITOR_JOB_STARTED__ = true;
  console.log(
    `[SlaMonitorJob] Started with interval ${SLA_MONITOR_INTERVAL_MS}ms`,
  );
  setInterval(processSlaBreaches, SLA_MONITOR_INTERVAL_MS);
  void processSlaBreaches();
};

export default startSlaMonitorJob;
