# Trailhead Batch

## Summary

This is a simple batch that scrape data from Trailhead profile pages and update `Trailblazer__c` records in Salesforce.

## Trailblazer__c Object

`Trailblazer__c` object has below fields.

- Name
- Badges__c <- If field history is enabled, you can easily find differences.
- Points__c <- If field history is enabled, you can easily find differences.
- Trails__c
- Profile_Link__c <- Just scraping data from this field value. Not update.

## Config

Edit `config/default.json`.

## Special thanks

[meruff/trailhead\-leaderboard](https://github.com/meruff/trailhead-leaderboard)

## License

This project is licensed under the MIT License - see the [LICENSE.txt](LICENSE.txt) file for details.
