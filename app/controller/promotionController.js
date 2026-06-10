import Promotion from "../models/promotion.js";
import Order from "../models/order.js";
import handleResponse from "../utils/helper.js";

// --- ADMIN APIs ---

export const listPromotions = async (req, res) => {
    try {
        const { search, type, status } = req.query;
        let query = {};

        if (search) {
            query.$or = [
                { code: { $regex: search, $options: "i" } },
                { title: { $regex: search, $options: "i" } },
            ];
        }

        if (type) query.promotionType = type;
        if (status === "active") query.isActive = true;
        else if (status === "inactive") query.isActive = false;

        const promotions = await Promotion.find(query).sort({ createdAt: -1 }).lean();
        return handleResponse(res, 200, "Promotions fetched successfully", promotions);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const getPromotion = async (req, res) => {
    try {
        const promotion = await Promotion.findById(req.params.id);
        if (!promotion) return handleResponse(res, 404, "Promotion not found");
        return handleResponse(res, 200, "Promotion fetched", promotion);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const createPromotion = async (req, res) => {
    try {
        const data = req.body;
        data.code = data.code?.toUpperCase();

        if (data.promotionType === "coupon" && !data.code) {
            return handleResponse(res, 400, "Coupon code is required");
        }

        if (data.code) {
            const existing = await Promotion.findOne({ code: data.code });
            if (existing) {
                return handleResponse(res, 400, "Promotion code already exists");
            }
        }

        const promotion = await Promotion.create(data);
        return handleResponse(res, 201, "Promotion created successfully", promotion);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const updatePromotion = async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        if (data.code) data.code = data.code.toUpperCase();

        const promotion = await Promotion.findByIdAndUpdate(id, data, {
            new: true,
            runValidators: true,
        });

        if (!promotion) return handleResponse(res, 404, "Promotion not found");
        return handleResponse(res, 200, "Promotion updated successfully", promotion);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const updateStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;
        const promotion = await Promotion.findByIdAndUpdate(
            id,
            { isActive },
            { new: true }
        );
        if (!promotion) return handleResponse(res, 404, "Promotion not found");
        return handleResponse(res, 200, "Status updated", promotion);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const deletePromotion = async (req, res) => {
    try {
        await Promotion.findByIdAndDelete(req.params.id);
        return handleResponse(res, 200, "Promotion deleted successfully");
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const getAnalytics = async (req, res) => {
    try {
        const promotion = await Promotion.findById(req.params.id);
        if (!promotion) return handleResponse(res, 404, "Promotion not found");

        const orders = await Order.find({ promotionApplied: promotion._id });
        const totalRevenue = orders.reduce((sum, o) => sum + (o.pricing?.total || 0), 0);
        const totalDiscountGiven = orders.reduce((sum, o) => sum + (o.pricing?.discount || 0), 0);

        return handleResponse(res, 200, "Analytics fetched", {
            usedCount: promotion.usedCount,
            totalRevenue,
            totalDiscountGiven,
            ordersCount: orders.length,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// --- CUSTOMER APIs ---

// Helper function to validate a single promotion against cart/user context
const validatePromoRules = async (promo, { cartTotal, items, customerId }) => {
    const now = new Date();

    if (!promo.isActive) return { valid: false, reason: "Promotion is not active" };
    if (promo.validFrom && promo.validFrom > now) return { valid: false, reason: "Promotion has not started yet" };
    if (promo.validTill && promo.validTill < now) return { valid: false, reason: "Promotion has expired" };

    if (promo.usageLimit && promo.usedCount >= promo.usageLimit) {
        return { valid: false, reason: "Promotion usage limit reached" };
    }

    if (promo.conditions?.minOrderValue && cartTotal < promo.conditions.minOrderValue) {
        return { valid: false, reason: `Minimum order value should be ₹${promo.conditions.minOrderValue}` };
    }

    if (promo.conditions?.maxOrderValue && cartTotal > promo.conditions.maxOrderValue) {
        return { valid: false, reason: `Maximum order value for this promotion is ₹${promo.conditions.maxOrderValue}` };
    }

    const totalQty = items?.reduce((sum, item) => sum + (item.quantity || 1), 0) || 0;
    if (promo.conditions?.minQuantity && totalQty < promo.conditions.minQuantity) {
        return { valid: false, reason: `Add at least ${promo.conditions.minQuantity} items to use this promotion` };
    }

    if (customerId) {
        // User specific checks
        const userOrdersCount = await Order.countDocuments({ customer: customerId });
        
        if (promo.conditions?.firstOrderOnly && userOrdersCount > 0) {
            return { valid: false, reason: "This promotion is only valid for your first order" };
        }

        if (promo.conditions?.newUserOnly && userOrdersCount > 0) {
            return { valid: false, reason: "This promotion is only available for new users" };
        }

        if (promo.conditions?.applicableUsers?.length > 0) {
            if (!promo.conditions.applicableUsers.includes(customerId)) {
                return { valid: false, reason: "You are not eligible for this promotion" };
            }
        }

        if (promo.perUserLimit) {
            const userUsageCount = await Order.countDocuments({ 
                customer: customerId, 
                promotionApplied: promo._id 
            });
            if (userUsageCount >= promo.perUserLimit) {
                return { valid: false, reason: `You have reached the usage limit for this promotion` };
            }
        }
    } else if (promo.conditions?.firstOrderOnly || promo.conditions?.newUserOnly || promo.conditions?.applicableUsers?.length > 0 || promo.perUserLimit) {
        // If it requires user validation, they must be logged in (though typically checkout passes customerId)
        return { valid: false, reason: "Please login to use this promotion" };
    }

    // Product & Category validation
    if (promo.conditions?.applicableCategories?.length > 0) {
        const hasApplicableCategory = items?.some(item => 
            item.category && promo.conditions.applicableCategories.map(c => c.toString()).includes(item.category.toString())
        );
        if (!hasApplicableCategory) {
            return { valid: false, reason: "Your cart does not contain eligible categories for this promotion" };
        }
    }

    if (promo.conditions?.applicableProducts?.length > 0) {
        const hasApplicableProduct = items?.some(item => 
            promo.conditions.applicableProducts.map(p => p.toString()).includes(item.productId?.toString() || item._id?.toString())
        );
        if (!hasApplicableProduct) {
            return { valid: false, reason: "Your cart does not contain eligible products for this promotion" };
        }
    }

    // Calculate discount
    let discountAmount = 0;
    let freeDelivery = false;

    if (promo.discountType === "free_delivery") {
        freeDelivery = true;
    } else if (promo.discountType === "percentage") {
        discountAmount = Math.round((cartTotal * promo.discountValue) / 100);
    } else if (promo.discountType === "fixed") {
        discountAmount = promo.discountValue;
    }

    if (promo.maxDiscount && discountAmount > promo.maxDiscount) {
        discountAmount = promo.maxDiscount;
    }

    if (discountAmount <= 0 && !freeDelivery) {
        return { valid: false, reason: "This promotion does not provide any discount on current cart" };
    }

    return { 
        valid: true, 
        discountAmount, 
        freeDelivery 
    };
};

export const getAvailablePromotions = async (req, res) => {
    try {
        const { customerId } = req.query;
        const now = new Date();
        const activePromotions = await Promotion.find({
            isActive: true,
            $or: [{ validFrom: null }, { validFrom: { $lte: now } }],
            $or: [{ validTill: null }, { validTill: { $gte: now } }]
        }).sort({ priority: -1, createdAt: -1 }).lean();

        let filteredPromotions = activePromotions;

        if (customerId) {
            const userOrdersCount = await Order.countDocuments({ customer: customerId });
            
            filteredPromotions = [];
            for (const promo of activePromotions) {
                let isEligible = true;
                
                if (promo.conditions?.firstOrderOnly && userOrdersCount > 0) {
                    isEligible = false;
                }
                
                if (promo.conditions?.newUserOnly && userOrdersCount > 0) {
                    isEligible = false;
                }
                
                if (promo.conditions?.applicableUsers?.length > 0) {
                    if (!promo.conditions.applicableUsers.map(id => id.toString()).includes(customerId)) {
                        isEligible = false;
                    }
                }
                
                if (promo.perUserLimit) {
                    const userUsageCount = await Order.countDocuments({ 
                        customer: customerId, 
                        promotionApplied: promo._id 
                    });
                    if (userUsageCount >= promo.perUserLimit) {
                        isEligible = false;
                    }
                }
                
                if (isEligible) {
                    filteredPromotions.push(promo);
                }
            }
        }

        return handleResponse(res, 200, "Promotions fetched", filteredPromotions);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const validatePromotion = async (req, res) => {
    try {
        const { code, cartTotal, items, customerId } = req.body;

        if (!code) {
            return handleResponse(res, 400, "Promotion code is required");
        }

        const promo = await Promotion.findOne({ code: code.toUpperCase() });
        if (!promo) {
            return handleResponse(res, 404, "Invalid promotion code");
        }

        const result = await validatePromoRules(promo, { cartTotal, items, customerId });
        
        if (!result.valid) {
            return handleResponse(res, 400, result.reason);
        }

        return handleResponse(res, 200, "Promotion applied", {
            promotionId: promo._id,
            code: promo.code,
            discountAmount: result.discountAmount,
            freeDelivery: result.freeDelivery,
        });

    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
