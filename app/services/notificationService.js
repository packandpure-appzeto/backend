import Notification from "../models/notification.js";
import User from "../models/customer.js";
import Seller from "../models/seller.js";
import Delivery from "../models/delivery.js";
import PickupPartner from "../models/pickupPartner.js";
import { sendFcmNotification } from "./firebaseService.js";

const modelMap = {
  Customer: User,
  Seller: Seller,
  Delivery: Delivery,
  PickupPartner: PickupPartner,
};

export const createNotification = async ({
  recipient,
  recipientModel,
  title,
  message,
  type = "order",
  data = {},
}) => {
  const note = await Notification.create({
    recipient,
    recipientModel,
    title,
    message,
    type,
    data,
  });

  const Model = modelMap[recipientModel];
  if (!Model) return note;

  try {
    const recipientDoc = await Model.findById(recipient)
      .select("fcmTokens")
      .lean();
    if (recipientDoc?.fcmTokens?.length) {
      await sendFcmNotification(recipientDoc.fcmTokens, {
        title,
        body: message,
        data: {
          ...data,
          notificationType: type,
        },
      });
    }
  } catch (error) {
    console.warn("[NotificationService] FCM send failed", error.message);
  }

  return note;
};
