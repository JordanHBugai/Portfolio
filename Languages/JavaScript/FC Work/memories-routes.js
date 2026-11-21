/* For stories routes */
import { Router, query } from "express";
import multer, { memoryStorage } from "multer";
import inputValidator from "../middleware/input_validator.js";
import rateLimiter from "../middleware/rate_limiter.js";


import { pgQuery, s3Delete, s3Upload, s3Retrieve, getUserInfoFromIdToken, checkReactionExists } from "../functions/general_functions.js";
import getDynamoRequestBuilder from "../config/dynamoDB.js";

import { setStory, setStoryReactions } from "../dynamo_schemas/dynamo_schemas.js";
import { verifyTokens } from "../middleware/verify.js";

const router = Router();
const storage = memoryStorage();
const upload = multer({ storage: storage });



router.get("/", verifyTokens, rateLimiter(), inputValidator, async (req, res, next) => {
    try {
        const { payload } = req.body;
        const userID = payload.user_id;

        // Querying DynamoDB to get user stories
        let stories = await getDynamoRequestBuilder("Stories")
            .query("user_id", parseInt(userID))
            .useIndex("user_id-created_at-index")
            .scanIndexDescending()
            .exec();

        // Filter and process stories
        const filteredStories = {};
        for (let story of stories) {
            if (story.store_in_memory != null) {
                if (story.imageUrl != null) {
                    story.imageUrl = await s3Retrieve(story.imageUrl);
                }
                const dateStr = story.created_at.split('T')[0]; // Extract date string
                console.log(dateStr)
                if (!filteredStories[dateStr]) {
                    filteredStories[dateStr] = []; // Initialize array if not exists
                }
                filteredStories[dateStr].push(story); // Push story to the array
            }
        }

        // Format the response
        const response = Object.keys(filteredStories).map(date => {
            return {
                date: date,
                snaps: filteredStories[date]
            };
        });

        return res.status(200).json({ memories: response });
    } catch (error) {
        // Pass error to the next middleware
        next(error);
    }
});


export default router