import crypto from 'crypto';
import Order from '../models/order.js';
import OrderOtp from '../models/orderOtp.js';
import { checkProximity } from './proximityService.js';

/**
 * Generate OTP for delivery completion (proximity-validated)
 * @param {string} orderId - Order identifier
 * @param {Object} deliveryLocation - Current delivery person location
 * @param {number} deliveryLocation.lat - Latitude
 * @param {number} deliveryLocation.lng - Longitude
 * @returns {Promise<Object>} { success: boolean, otp?: string, error?: string, expiresAt?: Date }
 */
export async function generateDeliveryOtp(orderId, deliveryLocation) {
  try {
    // Validate input
    if (!orderId || typeof orderId !== 'string') {
      return {
        success: false,
        error: 'Valid orderId is required'
      };
    }

    if (!deliveryLocation || typeof deliveryLocation !== 'object') {
      return {
        success: false,
        error: 'Valid delivery location is required'
      };
    }

    if (typeof deliveryLocation.lat !== 'number' || typeof deliveryLocation.lng !== 'number') {
      return {
        success: false,
        error: 'Delivery location must have numeric lat and lng properties'
      };
    }

    // Find the order
    const order = await Order.findOne({ orderId });
    if (!order) {
      return {
        success: false,
        error: 'Order not found'
      };
    }

    // Check if order has delivery location
    if (!order.address?.location?.lat || !order.address?.location?.lng) {
      console.error('Order location validation failed:', {
        orderId: order.orderId,
        hasAddress: !!order.address,
        hasLocation: !!order.address?.location,
        location: order.address?.location,
        lat: order.address?.location?.lat,
        lng: order.address?.location?.lng
      });
      return {
        success: false,
        error: 'This order does not have delivery coordinates saved. Please contact support or ask the customer to provide their exact location. The order was likely created before location tracking was enabled.'
      };
    }

    const customerLocation = {
      lat: order.address.location.lat,
      lng: order.address.location.lng
    };

    // Validate proximity
    let proximityCheck;
    try {
      proximityCheck = checkProximity(deliveryLocation, customerLocation);
    } catch (error) {
      return {
        success: false,
        error: `Proximity check failed: ${error.message}`
      };
    }

    if (!proximityCheck.inRange) {
      const threshold = parseInt(process.env.PROXIMITY_THRESHOLD_METERS || "5000", 10);
      return {
        success: false,
        error: `Delivery person must be within 0-${threshold} meters of delivery location. Current distance: ${Math.round(proximityCheck.distance)}m`
      };
    }

    // Generate secure 4-digit OTP using crypto.randomInt
    const otp = String(crypto.randomInt(0, 10000)).padStart(4, '0');

    // Hash the OTP for storage
    const codeHash = OrderOtp.hashCode(otp);

    // Set expiration time to 10 minutes from now
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Invalidate any previous OTPs for this order
    await OrderOtp.updateMany(
      { orderId, consumedAt: null },
      { consumedAt: new Date() }
    );

    // Create new OTP record
    await OrderOtp.create({
      orderId,
      orderMongoId: order._id,
      codeHash,
      expiresAt,
      attempts: 0,
      maxAttempts: 3,
      lastGeneratedAt: new Date()
    });

    return {
      success: true,
      otp,
      expiresAt
    };
  } catch (error) {
    console.error('Error generating delivery OTP:', error);
    return {
      success: false,
      error: 'Failed to generate OTP. Please try again.'
    };
  }
}

/**
 * Check if OTP is expired
 * @param {Date} expiresAt - OTP expiration timestamp
 * @returns {boolean}
 */
export function isOtpExpired(expiresAt) {
  return new Date() > new Date(expiresAt);
}

/**
 * Validate OTP entered by delivery person
 * @param {string} orderId - Order identifier
 * @param {string} enteredOtp - 4-digit OTP entered by delivery person
 * @returns {Promise<Object>} { valid: boolean, error?: string, attemptsRemaining?: number }
 */
export async function validateDeliveryOtp(orderId, enteredOtp) {
  try {
    // Validate input format
    if (!orderId || typeof orderId !== 'string') {
      return {
        valid: false,
        error: 'INVALID_FORMAT',
        message: 'Valid orderId is required'
      };
    }

    if (!enteredOtp || typeof enteredOtp !== 'string') {
      return {
        valid: false,
        error: 'INVALID_FORMAT',
        message: 'OTP is required'
      };
    }

    // Validate OTP format: exactly 4 digits
    const otpPattern = /^\d{4}$/;
    if (!otpPattern.test(enteredOtp)) {
      return {
        valid: false,
        error: 'INVALID_FORMAT',
        message: 'OTP must be exactly 4 digits'
      };
    }

    // Find active OTP for this order
    const otpRecord = await OrderOtp.findOne({
      orderId,
      consumedAt: null
    }).sort({ lastGeneratedAt: -1 });

    if (!otpRecord) {
      return {
        valid: false,
        error: 'OTP_NOT_FOUND',
        message: 'No active OTP found for this order'
      };
    }

    // Check if max attempts exceeded
    if (otpRecord.attempts >= otpRecord.maxAttempts) {
      return {
        valid: false,
        error: 'MAX_ATTEMPTS_EXCEEDED',
        message: 'Maximum validation attempts exceeded. Supervisor intervention required.',
        attemptsRemaining: 0
      };
    }

    // Check OTP expiration before validation
    if (isOtpExpired(otpRecord.expiresAt)) {
      return {
        valid: false,
        error: 'OTP_EXPIRED',
        message: 'OTP has expired. Please generate a new OTP.',
        attemptsRemaining: otpRecord.maxAttempts - otpRecord.attempts
      };
    }

    // Hash the entered OTP and compare with stored hash
    const enteredHash = OrderOtp.hashCode(enteredOtp);
    const isMatch = enteredHash === otpRecord.codeHash;

    if (!isMatch) {
      // Increment attempts
      otpRecord.attempts += 1;
      await otpRecord.save();

      const attemptsRemaining = otpRecord.maxAttempts - otpRecord.attempts;

      return {
        valid: false,
        error: 'OTP_MISMATCH',
        message: 'Invalid OTP. Please try again.',
        attemptsRemaining
      };
    }

    // OTP is valid - mark as consumed
    otpRecord.consumedAt = new Date();
    await otpRecord.save();

    return {
      valid: true,
      message: 'OTP validated successfully'
    };
  } catch (error) {
    console.error('Error validating delivery OTP:', error);
    return {
      valid: false,
      error: 'VALIDATION_FAILED',
      message: 'Failed to validate OTP. Please try again.'
    };
  }
}
