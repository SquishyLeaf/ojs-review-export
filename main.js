import "dotenv/config";
import { createConnection } from "mariadb";
import { open, copyFile } from "fs/promises";
import * as path from "path";

const currentDate = new Date().toLocaleDateString();

// Values are either properties to look up in review object
// or functions that take review object as an argument
// and return a string (usually an HTML snippet).
const symbols = new Map([
    ["REVIEW_ID", "reviewId"],
    ["ARTICLE_ID", "submissionId"],
    ["SUBMISSION_DATE", "dateCompleted"],
    ["ARTICLE_TITLE", "articleTitle"],
    ["FORM_RESPONSES", printResponses],
    ["RECOMMENDATION", "recommendation"],
    ["CURRENT_DATE", "dateGenerated"],
    ["JOURNAL_TITLE", "journalTitle"],
    ["REVIEWER_NAME", "reviewerName"],
    ["AUTHORS", printAuthors],
]);

// The reviewer recommendation order has to match
// the order visible on the review form itself
// also specified in
// /lib/pkp/classes/submission/reviewAssignment/ReviewAssignment.inc.php
const recommendations = [
    "None",
    "Accept Submission",
    "Revisions Required",
    "Resubmit for Review",
    "Resubmit Elsewhere",
    "Decline Submission",
    "See Comments",
];

// Comment labels in "Free form reviews".
const viewableCommentLabel = "Comment for author and editor";
const nonViewableCommentLabel = "Comment for editor only";

const conn = await createConnection({
    host: process.env.DB_HOST,
    socketPath: process.env.DB_SOCKET,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    bigIntAsNumber: true,
});

const config = {
    from: undefined,
    to: undefined,
    path: process.cwd(),
    locale: "en",
    filesDir: process.env.OJS_FILES_DIR,
};

if (process.argv.includes("-h")) {
    console.log(
        "Usage: ojs-review-export [-p <output_path>] [-f <date_from>] [-t <date_to>]"
    );
    process.exit(0);
}

if (process.env.LOCALE) {
    config.locale = process.env.LOCALE.replace("-", "_");
}

if (!config.filesDir) {
    config.filesDir = "/var/www/files";
}

const pathOptionIndex = process.argv.findIndex((arg) => arg == "-p");
const fromOptionIndex = process.argv.findIndex((arg) => arg == "-f");
const toOptionIndex = process.argv.findIndex((arg) => arg == "-t");

if (pathOptionIndex > 0) {
    config.path = process.argv[pathOptionIndex + 1];
}

if (fromOptionIndex > 0) {
    config.from = new Date(process.argv[fromOptionIndex + 1]);
}

if (toOptionIndex > 0) {
    config.to = new Date(process.argv[toOptionIndex + 1]);
}

let subsRevs;

if (config.from && config.to) {
    subsRevs = await conn.query(
        `SELECT
    review_assignments.review_id as revId,
    review_assignments.submission_id as subId,
    review_assignments.recommendation,
    date_completed as dateCompleted
    FROM review_assignments
    WHERE DATE(date_completed) BETWEEN ? AND ?`,
        [config.from, config.to]
    );
} else {
    subsRevs = await conn.query(
        `SELECT
    review_assignments.review_id as revId,
    review_assignments.submission_id as subId,
    review_assignments.recommendation,
    date_completed as dateCompleted
    FROM review_assignments
    WHERE DATE(date_completed) > NOW() - INTERVAL 1 DAY`
    );
}

if (subsRevs.length == 0) {
    console.log("No reviews found.");
    process.exit(1);
}

const reviews = [];

for (const subRev of subsRevs) {
    const review = {
        reviewId: subRev.revId,
        submissionId: subRev.subId,
        authorsName: "",
        reviewerName: "",
        dateCompleted: subRev.dateCompleted.toLocaleDateString(),
        dateGenerated: currentDate,
        recommendation: recommendations[subRev.recommendation],
    };

    // Submission IDs and publication IDs may not
    // match for the same article.
    const currentPublicationId = await conn.query(
        `SELECT current_publication_id as id
      FROM submissions
      WHERE submission_id = ?
    `,
        [review.submissionId]
    );

    review.publicationId = currentPublicationId[0].id;

    // Get non-empty article titles, prioritizing
    // the selected locale. Since OJS does not enforce
    // metadata translations by default, the title in
    // preferred language may not be available.
    const titles = await conn.query(
        `SELECT setting_value AS value,locale
      FROM publication_settings
      WHERE publication_id = ?
      AND setting_name = 'title'
      AND setting_value <> ''
      ORDER BY locale = ? DESC
    `,
        [review.publicationId, config.locale]
    );

    review.articleTitle = titles[0].value;

    const journalTitles = await conn.query(
        `SELECT js.setting_value AS value
      FROM journal_settings js
      INNER JOIN submissions sub
      ON sub.context_id = js.journal_id
      WHERE sub.submission_id = ?
      AND js.setting_name = 'name'
    `,
        [review.submissionId]
    );

    review.journalTitle = journalTitles[0].value;

    const authorIDs = await conn.query(
        `SELECT author_id as id
    FROM authors
    WHERE publication_id = ?`,
        [review.publicationId]
    );

    const authors = [];

    for (const id of authorIDs) {
        const authorName = await conn.query(
            `SELECT set1.setting_value AS firstName,
        set2.setting_value AS lastName
        FROM author_settings set1
        INNER JOIN author_settings set2
        ON set1.author_id = set2.author_id
        WHERE set1.setting_name = 'givenName'
        AND set2.setting_name = 'familyName'
        AND set1.author_id = ?
        AND set1.setting_value <> ''
        AND set1.locale = set2.locale
        ORDER BY set1.locale = ? DESC
      `,
            [id.id, config.locale]
        );

        authors.push(`${authorName[0].firstName} ${authorName[0].lastName}`);
    }

    review.articleAuthors = authors;

    const reviewerName = await conn.query(
        `SELECT set1.setting_value AS firstName,
      set2.setting_value AS lastName
      FROM user_settings set1
      INNER JOIN user_settings set2
      ON set1.user_id = set2.user_id
      WHERE set1.setting_name = 'givenName'
      AND set2.setting_name = 'familyName'
      AND set1.user_id =
      (SELECT reviewer_id
        FROM review_assignments
        WHERE review_id = ?)
      AND set1.setting_value <> ''
      AND set2.setting_value <> ''
      AND set1.locale = set2.locale
      ORDER BY set1.locale = ? DESC
      `,
        [review.reviewId, config.locale]
    );

    review.reviewerName =
        reviewerName[0].firstName + " " + reviewerName[0].lastName;

    const reviewData = await conn.query(
        `SELECT
      sets.review_form_element_id AS id,
      sets.setting_name AS settingName,
      sets.setting_value AS settingValue,
      sets.setting_type AS settingType,
      res.response_type AS responseType,
      res.response_value AS responseValue
      FROM review_form_element_settings sets
      INNER JOIN review_form_responses res
      ON sets.review_form_element_id = res.review_form_element_id
      WHERE res.review_id = ? AND sets.locale = ?
    `,
        [review.reviewId, config.locale]
    );

    // When this collection is empty, the review
    // is most likely a "Free form review"
    // and these are stored in a different table
    if (reviewData.length == 0) {
        const comments = await conn.query(
            `SELECT viewable,comments
      FROM submission_comments
      WHERE assoc_id = ?`,
            [review.reviewId]
        );

        review.fields = [];

        for (const comment of comments) {
            review.fields.push({
                id: 0,
                description: "",
                question:
                    comment.viewable == 1
                        ? viewableCommentLabel
                        : nonViewableCommentLabel,
                response: comment.comments,
            });
        }
    } else {
        review.fields = transformReviewFields(reviewData);
    }

    const paths = await conn.query(
        `SELECT path
    FROM files f
    INNER JOIN submission_files sf
    ON sf.file_id = f.file_id
    WHERE sf.assoc_type = 517 AND sf.assoc_id = ?`,
        [review.reviewId]
    );

    review.files = paths;

    reviews.push(review);
}

for (const review of reviews) {
    const outputPath = path.join(config.path, `Review_${review.reviewId}.html`);
    const outputFile = await open(outputPath, "w");
    const template = await open("./template.html");

    for await (const line of template.readLines()) {
        await outputFile.write(expandSymbols(line, review) + "\n");
    }

    outputFile.close();
}

for (const review of reviews) {
    await copyReviewFiles(review);
}

console.log(`Exported ${reviews.length} reviews to ${config.path} directory.`);
conn.end();

function transformReviewFields(reviewData) {
    const fields = new Map();

    for (const fieldSetting of reviewData) {
        const fieldKey = fieldSetting.id;

        if (!fields.get(fieldKey)) fields.set(fieldKey, Object.create(null));

        fields.get(fieldKey)["id"] = fieldKey;

        if (fieldSetting.settingType == "object") {
            fields.get(fieldKey)[fieldSetting.settingName] = JSON.parse(
                fieldSetting.settingValue
            );
        } else {
            fields.get(fieldKey)[fieldSetting.settingName] =
                fieldSetting.settingValue;
        }

        if (fieldSetting.responseType == "object") {
            fields.get(fieldKey)["response"] = JSON.parse(fieldSetting.responseValue);
        } else {
            fields.get(fieldKey)["response"] = fieldSetting.responseValue;
        }
    }

    return Array.from(fields.values());
}

function expandSymbols(line, review) {
    const bracesStart = line.indexOf("{{");

    if (bracesStart < 0) return line;

    const bracesEnd = line.indexOf("}}", bracesStart);

    const symbol = line.substring(bracesStart + 2, bracesEnd).trim();
    const value = symbols.get(symbol);

    return (
        line.substring(0, bracesStart) +
        (typeof value == "function" ? value(review) : review[value]) +
        expandSymbols(line.substring(bracesEnd + 2), review)
    );
}

function printResponses(review) {
    let result = "";
    for (const field of review.fields) {
        result += "<li>";
        result += `
      <h3>${field.question}</h3>
      <div class="question-description">${field.description}</div>
    `;

        if (field.possibleResponses) {
            result += `<ol class="options">`;
            for (let i = 0; i < field.possibleResponses.length; i++) {
                if (
                    i == field.response ||
                    (Array.isArray(field.response) && field.response.includes(i))
                ) {
                    result += `<li class="option-selected">${field.possibleResponses[i]}</li>`;
                } else {
                    result += `<li>${field.possibleResponses[i]}</li>`;
                }
            }
            result += "</ol>";
        } else {
            result += `<div class="comment-text">${field.response.replaceAll(
                "\n",
                "<br>"
            )}</div>`;
        }

        result += "</li>";
    }

    return result;
}

function printAuthors(review) {
    return `<p class="authors">Authors: <strong>${review.articleAuthors.join(
        ", "
    )}</strong></p>`;
}

async function copyReviewFiles(review) {
    for (const filePath of review.files) {
        await copyFile(
            path.join(config.filesDir, filePath.path),
            path.join(
                config.path,
                `Review_${review.reviewId}_${path.basename(filePath.path)}`
            )
        );
    }
}
