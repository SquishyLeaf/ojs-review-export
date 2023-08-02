# OJS Review Export

This tool exports reviews submitted to OJS as HTML files based on the provided template. It works both for reviews submitted using the default "Free form review" form, as well as user-defined review forms.

## Usage

Install dependencies using `npm install`.

Run with `node main.js [-p <output_path>] [-f <date_from>] [-t <date_to>]`.

If output path is skipped, reviews will be exported to current working directory. If dates are not provided, reviews from submitted in past 24 hours will be exported. Dates should be formatted as YYYY-MM-DD.

Additional files submitted by the reviewer will be copied and renamed to appear next to the HTML file containing the exported review.

### Environment variables

- DB_HOST/DB_SOCKET – provide either one of those, depending on how you connect to the database.
- DB_USER
- DB_NAME
- DB_PASSWORD
- LOCALE – `en_US` by default. If your journal has forms in multiple languages, the one specified here will be prioritized.
- OJS_FILES_DIR – `/var/www/files` by default. You need read permissions for this directory.

## Limitations

Some text in OJS reviews is not meant to be customizable via the web client, so it does not appear in the database. Since parsing app's internationalization files is a little bit beyond the scope of this project, these strings should be hardcoded for now.

This applies to:

1. List of possible recommendations the reviewer can give when finalizing their review – `recommendations` constant.
2. Text input field labels in free form reviews – `viewableCommentLabel` and `nonViewableCommentLabel` constants.

## TODO

- Improve the HTML template (it's really ugly right now)
- Optimize SQL queries
- Add more export format options, possibly by converting the HTML output
- Add multi-language support
