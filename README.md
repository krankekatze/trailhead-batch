# Trailhead Batch

## Summary

This is a simple batch that scrapes data from Trailhead profile pages and update `Trailblazer__c` records in Salesforce.

## Trailblazer__c Object

`Trailblazer__c` object has below fields.

- Name
- Badges__c [*1]
- Points__c [*1]
- Trails__c [*1]
- Profile_Link__c [*2]

[*1]: If field history is enabled, you can easily find differences.

[*2]: The batch scrapes data from this field value and doesn't update the field.

## Config

Edit `config/default.json`.

## Special thanks

[meruff/trailhead\-leaderboard](https://github.com/meruff/trailhead-leaderboard)

## License

This project is licensed under the MIT License - see the [LICENSE.txt](LICENSE.txt) file for details.
