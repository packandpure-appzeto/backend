import Order from "../models/order.js";
import Delivery from "../models/delivery.js";
import { WORKFLOW_STATUS } from "../constants/orderWorkflow.js";

/**
 * Service to manage delivery partner workflows.
 */

export const getAvailableOrders = async (location, radiusMeters) => {
  // Logic for broadcasting/radius matching usually happens in orderWorkflowService
  // but we can wrap it here for a cleaner API.
  return []; 
};

export const assignDeliveryPartner = async (orderId, deliveryBoyId) => {
  return await Order.findOneAndUpdate(
    { orderId },
    { 
      $set: { 
        deliveryBoy: deliveryBoyId, 
        workflowStatus: WORKFLOW_STATUS.DELIVERY_ASSIGNED,
        assignedAt: new Date()
      } 
    },
    { new: true }
  );
};

export const updateLiveLocation = async (deliveryBoyId, lat, lng) => {
  return await Delivery.findByIdAndUpdate(
    deliveryBoyId,
    { 
      $set: { 
        "location.coordinates": [lng, lat],
        lastLocationAt: new Date()
      } 
    },
    { new: true }
  );
};
