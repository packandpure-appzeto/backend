import Order from "../models/order.js";
import Transaction from "../models/transaction.js";
import HubInventory from "../models/hubInventory.js";
import Seller from "../models/seller.js";
import handleResponse from "../utils/helper.js";
import { resolveOrderItemVariantLabel } from "../utils/orderItemHelpers.js";

/**
 * Utility to convert array of objects to CSV string
 */
const jsonToCsv = (data, fields) => {
  if (!data || !data.length) return "";
  const header = fields.join(",");
  const rows = data.map(item => {
    return fields.map(field => {
      let val = item[field] === undefined || item[field] === null ? "" : item[field];
      // Escape commas and quotes
      if (typeof val === "string" && (val.includes(",") || val.includes('"') || val.includes("\n"))) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(",");
  });
  return [header, ...rows].join("\n");
};

/* ===============================
   GST REPORT (Admin)
 ================================ */
export const exportGstReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const query = { status: "delivered" };

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const orders = await Order.find(query)
      .select("orderId createdAt items pricing")
      .populate("items.product", "name variants unit")
      .lean();

    const reportData = [];
    orders.forEach(order => {
      order.items.forEach(item => {
        if (item.gstAmount > 0 || item.gstRate > 0) {
          const variantLabel = resolveOrderItemVariantLabel(item);
          reportData.push({
            OrderId: order.orderId,
            Date: order.createdAt.toISOString().split("T")[0],
            Product: item.name || (item.product?.name) || "Unknown",
            Variant: variantLabel || "",
            Quantity: item.quantity,
            UnitPrice: item.price,
            TaxableAmount: ((item.price * item.quantity) - (item.gstAmount || 0)).toFixed(2),
            GstRate: `${item.gstRate}%`,
            GstAmount: item.gstAmount || 0,
            Total: (item.price * item.quantity).toFixed(2)
          });
        }
      });
    });

    const csv = jsonToCsv(reportData, [
      "OrderId", "Date", "Product", "Variant", "Quantity", "UnitPrice", "TaxableAmount", "GstRate", "GstAmount", "Total"
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=gst_report_${Date.now()}.csv`);
    return res.status(200).send(csv);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   VENDOR PAYOUTS REPORT (Admin)
 ================================ */
export const exportVendorPayoutsReport = async (req, res) => {
  try {
    const sellers = await Seller.find({ isVerified: true }).select("shopName name phone").lean();
    const sellerIds = sellers.map(s => s._id);

    const transactions = await Transaction.find({
      user: { $in: sellerIds },
      userModel: "Seller"
    }).lean();

    const reportData = sellers.map(seller => {
      const sellerTxns = transactions.filter(t => String(t.user) === String(seller._id));
      
      const totalEarnings = sellerTxns
        .filter(t => t.type === "Supply Earning")
        .reduce((acc, t) => acc + (t.amount || 0), 0);
        
      const settledPayouts = sellerTxns
        .filter(t => t.type === "Withdrawal" && t.status === "Settled")
        .reduce((acc, t) => acc + Math.abs(t.amount || 0), 0);
        
      const pendingPayouts = sellerTxns
        .filter(t => t.type === "Withdrawal" && (t.status === "Pending" || t.status === "Processing"))
        .reduce((acc, t) => acc + Math.abs(t.amount || 0), 0);

      return {
        VendorName: seller.name,
        ShopName: seller.shopName,
        Phone: seller.phone,
        TotalEarnings: totalEarnings.toFixed(2),
        SettledPayouts: settledPayouts.toFixed(2),
        PendingPayouts: pendingPayouts.toFixed(2),
        CurrentWalletBalance: (totalEarnings - settledPayouts - pendingPayouts).toFixed(2)
      };
    });

    const csv = jsonToCsv(reportData, [
      "VendorName", "ShopName", "Phone", "TotalEarnings", "SettledPayouts", "PendingPayouts", "CurrentWalletBalance"
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=vendor_payouts_${Date.now()}.csv`);
    return res.status(200).send(csv);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   HUB INVENTORY REPORT (Admin)
 ================================ */
export const exportInventoryReport = async (req, res) => {
  try {
    const inventory = await HubInventory.find()
      .populate("productId", "name sku unit")
      .lean();

    const reportData = inventory.map(item => ({
      ProductName: item.productId?.name || "Unknown",
      SKU: item.productId?.sku || "N/A",
      Unit: item.productId?.unit || "Pieces",
      AvailableQty: item.availableQty || 0,
      ReservedQty: item.reservedQty || 0,
      TotalQty: (item.availableQty || 0) + (item.reservedQty || 0),
      AverageCost: (item.avgPurchaseCost || 0).toFixed(2),
      SellingPrice: (item.sellPrice || 0).toFixed(2),
      Status: item.status || "Unknown"
    }));

    const csv = jsonToCsv(reportData, [
      "ProductName", "SKU", "Unit", "AvailableQty", "ReservedQty", "TotalQty", "AverageCost", "SellingPrice", "Status"
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=inventory_report_${Date.now()}.csv`);
    return res.status(200).send(csv);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
