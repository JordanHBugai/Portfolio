import express from "express";

import rateLimiter from "../middleware/rate_limiter.js";
import inputValidator from "../middleware/input_validator.js";

import redis from "../config/redisConfig.js";
import { pgQuery } from "../functions/general_functions.js";
import { redisNewRecipe, redisRecipeExists } from "../functions/redis_functions.js";
import { verifyAccessOnly, verifyTokens, verifyUserIdentity } from "../middleware/verify.js";

const router = express.Router();

/* Testing Posts Route */
router.get("/testing", rateLimiter(), async (req, res) => {
  try {
    res.status(200).json({ "Testing": "Working Reipes" });

  } catch (err) {
    console.error(err.message);
  }
});

/**
 * Retrieves recipes based on ingredients.
 *
 * @route GET /
 * @param {string} req.query.ingredients - Comma-separated list of ingredients to search for
 * @param {number} req.query.page - Page number for pagination (default: 1)
 * @param {number} req.query.pageSize - Number of items per page (default: 10)
 * @returns {status} - If successful, returns 200 and a JSON object with the recipes, else returns 400 or 500 with a JSON object indicating the error.
 */
router.get("/search_by_ingredients", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
    const { ingredients, page = 1, pageSize = 10 } = req.query;
    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;

    // Check if ingredients parameter is provided
    if (!ingredients) {
      return res.status(400).json({
        message: "Ingredients parameter is required."
      });
    }

    // Ensure recipe_ingredients is an array
    let ingredientsArray = [];

    if (Array.isArray(ingredients)) {
      ingredientsArray = ingredients;
    } else if (typeof ingredients === 'string') {
      ingredientsArray = ingredients.split(',').map(item => item.trim());
    }

    // Prepare ingredients patterns for ILIKE matching
    const ingredientsPatterns = ingredientsArray.map(ingredient => `%${ingredient}%`);
    const query = `
    SELECT r.*, COUNT(DISTINCT p.label) AS unique_match_count FROM recipes r
    JOIN recipe_products rp ON r.id = rp.recipe_id
    JOIN products p ON rp.product_id = p.id
    WHERE p.label ILIKE ANY($1::text[])
    GROUP BY r.id
    ORDER BY unique_match_count DESC
    LIMIT $2 OFFSET $3
    `;
    // Retrieve paginated recipes
    const recipesResult = await pgQuery(query, [ingredientsPatterns], limit, offset);
    const recipes = recipesResult.rows;

    // Fetch ingredients and additional data for each recipe
    const recipesWithDetails = await Promise.all(recipes.map(async (recipe) => {
      // Fetch ingredients for the recipe
      const ingredientsResult = await pgQuery(
        "SELECT rp.*, p.label, p.imageurl FROM recipe_products rp JOIN products p ON rp.product_id = p.id WHERE rp.recipe_id = $1",
        recipe.id
      );
      // Extract ingredients
      const ingredients = ingredientsResult.rows;

      // Fetch categories for the recipe
      const categoriesResult = await pgQuery(
        "SELECT category_name FROM posts_categories WHERE post_id = $1",
        recipe.post_id
      );
      // Extract categories
      const categories = categoriesResult.rows.map(row => row.category_name);

      // Fetch post title for the recipe
      const postTitleResult = await pgQuery(
        "SELECT title FROM posts WHERE id=$1",
        recipe.post_id
      );
      // Extract post title
      const postTitle = postTitleResult.rows[0].title;

      // Add ingredients, categories, and post title to the recipe object
      recipe.recipe_ingredients = ingredients;
      recipe.categories = categories;
      recipe.title = postTitle;

      return recipe;
    }));

    return res.status(200).json({
      data: recipesWithDetails,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error."
    });
  }
});


/**
 * Route handler for getting a specific recipe by ID.
 *  It first checks if the recipe is cached in Redis, if not it fetches from the database and then caches it.
 *  The cached recipe expires after 1 hour.
 * This endpoint needs a request header called 'Authorisation' with the access token
 *
 * @route GET /:id
 * @param {any} *req.params.id - The Id of the post.
 * @returns {status} - If successful, returns 200 and a JSON object with the specific recipe, else returns 404 and a JSON object with error set to 'Recipe not found'
 */
router.get("/:recipe_id", verifyTokens, inputValidator, rateLimiter(), async (req, res, next) => {


  const recipeId = parseInt(req.params.recipe_id);

  try {
    // Fetch recipe from the database
    const specificRecipe = await pgQuery(
      "SELECT * FROM recipes WHERE id = $1",
      recipeId
    );

    // If recipe not found in the database, return 404 error
    if (specificRecipe.rows.length === 0) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    // Fetch ingredients for the recipe
    let ingredients = await pgQuery(
      "SELECT rp.*, p.label, p.imageurl FROM recipe_products rp JOIN products p ON rp.product_id = p.id WHERE rp.recipe_id = $1",
      recipeId
    );


    // Add ingredients to the recipe object
    specificRecipe.rows[0].recipe_ingredients = ingredients.rows;

    // Fetch categories for the recipe
    let recipeCategories = await pgQuery(
      "SELECT category_name FROM posts_categories WHERE post_id = $1",
      specificRecipe.rows[0].post_id
    );

    let postTitle = await pgQuery("SELECT title FROM posts WHERE id=$1", specificRecipe.rows[0].post_id)
    // Add categories to the recipe object
    specificRecipe.rows[0].categories = recipeCategories.rows;
    specificRecipe.rows[0].title = postTitle.rows[0].title

    // Return the fetched recipe
    return res.status(200).json({ recipe: specificRecipe.rows[0] });
  } catch (err) {
    console.error(`Error handling request for recipe post ${recipeId}:`, err);
    next(err);
  }
});

/**
 * Route handler for Update Recipes Table.
 * This will update the details in the recipes table.
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token
 * 
 * @route PUT /:post_id
 * @param {any} *req.params.post_id - The Id of the post
 * @body 
 * 		 recipe_description = String,
     recipe_ingredients = Array[Tuple[string]],
     recipe_equipment   = Array[string],
     recipe_steps       = Array[string],
     preparation_time   = INTEGER,
     serving_size       = INTEGER,
 * @returns {status} - If successful, returns 200 and a JSON object with message set to 'Recipe updated', else returns 404 and a JSON object with message set to 'Recipe not found'
 */
router.put("/:post_id", inputValidator, verifyUserIdentity, rateLimiter(), async (req, res, next) => {
  try {
    const { post_id } = req.params;

    const {
      recipe_description,
      recipe_ingredients,
      recipe_equipment,
      recipe_steps,
      preparation_time,
      serving_size,
    } = req.body;

    // Check if the recipe with the specified post_id exists
    const checkQuery = "SELECT * FROM recipes WHERE post_id = $1";
    const checkValues = [post_id];
    const existingRecipe = await pgQuery(checkQuery, ...checkValues);

    if (!existingRecipe.rows.length) {
      // If the recipe does not exist, return a "404 Not Found" response
      return res.status(404).json({ message: "Recipe not found" });
    }

    const query = `
		UPDATE recipes 
		SET 
		  recipe_description = $1, 
		  recipe_ingredients = $2, 
		  recipe_equipment = $3, 
		  recipe_steps = $4, 
		  preparation_time = $5, 
		  serving_size = $6,
		  updated_at = NOW()
		WHERE post_id = $7`;

    const values = [
      recipe_description,
      recipe_ingredients,
      recipe_equipment,
      recipe_steps,
      preparation_time,
      serving_size,
      post_id,
    ];

    await pgQuery(query, ...values);

    res.status(200).json({ message: "Recipe updated" });
  } catch (err) {
    next(err);
  }
});

// console.log(await pgQuery("SELECT * FROM posts_categories"))


export default router;