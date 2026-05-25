import mongoose from "mongoose";

const settingSchema = new mongoose.Schema(
    {
        // General
        appName: {
            type: String,
            default: "Appzeto Quick Commerce",
        },
        supportEmail: {
            type: String,
            default: "support@appzeto.com",
        },
        supportPhone: {
            type: String,
            default: "",
        },
        currencySymbol: {
            type: String,
            default: "₹",
        },
        currencyCode: {
            type: String,
            default: "INR",
        },
        timezone: {
            type: String,
            default: "Asia/Kolkata",
        },

        // Branding
        logoUrl: String,
        faviconUrl: String,
        primaryColor: {
            type: String,
            default: "#0ea5e9",
        },
        secondaryColor: {
            type: String,
            default: "#64748b",
        },

        // Legal
        companyName: String,
        taxId: String,
        address: String,

        // Social
        facebook: String,
        twitter: String,
        instagram: String,
        linkedin: String,
        youtube: String,

        // Apps
        playStoreLink: String,
        appStoreLink: String,

        // SEO
        metaTitle: String,
        metaDescription: String,
        metaKeywords: String,
        keywords: [{ type: String }], // Array for structured SEO keywords

        // Optional: multi-tenant (null = default tenant)
        tenantId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            index: true,
        },

        // Returns / logistics configuration
        returnDeliveryCommission: {
            // Flat amount per return pickup, paid by seller
            type: Number,
            default: 0,
        },
        codCancelBlockThreshold: {
            type: Number,
            default: 3,
            min: 1,
        },
        // Delivery Pricing Configuration
        hubLocation: {
            type: {
                type: String,
                enum: ["Point"],
                default: "Point",
            },
            coordinates: {
                type: [Number], // [lng, lat]
                default: [75.8975, 22.7533], // Default Indore Hub
            },
        },
        baseDeliveryFee: {
            type: Number,
            default: 20,
        },
        baseFreeKm: {
            type: Number,
            default: 1, // km covered by base fee before per-km charges start
        },
        perKmDeliveryCharge: {
            type: Number,
            default: 10,
        },
        freeDeliveryThreshold: {
            type: Number,
            default: 500,
        },
        platformFee: {
            type: Number,
            default: 3,
        },
        gstPercentage: {
            type: Number,
            default: 5, // Default 5%
        },
        gstRates: {
            type: [Number],
            default: [0, 5, 12, 18, 28],
        },
        maxServiceRadius: {
            type: Number,
            default: 15, // Default 15km
        },
    },
    {
        timestamps: true,
    }
);

export default mongoose.model("Setting", settingSchema);

