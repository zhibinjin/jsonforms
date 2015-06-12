# jsonforms

A Backbone based library for generating forms with json schema v4. 

## Supported Editors:

* Text
* TextArea
* Checkbox
* Select
* Checkboxes
* Radio
* HiddenJson
* Hidden
* Password
* ReadOnlyText
* ReadOnlyHtml
* DatePicker
* TinyMCE
* Image
* MultiImages

## Example

```javascript
var schema = {
    type: 'object',
    properties: {
        name: {
            type: 'string',
            title: 'Name'
        },
        images: {
            type: 'array',
            title: 'Images',
            description: 'At most 6 images can be uploaded',
            editor: 'MultiImages',
            inputAttributes: {
                uploadUrl: '/photos'
            }
        },
        description: {
            type: ['string', 'null'],
            title: 'Description',
            editor: 'TinyMCE'
        },
        attributes: {
            type: 'array',
            title: 'Attributes',
            items: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        title: 'Name'
                    },
                    value: {
                        type: 'string',
                        title: 'Value'
                    }
                }
            }
        }
    }
};

var form = new jsonforms.Form({
    schema: schema,
    buttons: {
        save: 'Save',
        close: 'Close'
    }
}).render();

form.setValue({name: 'test'});

form.on('change', function() {
    console.log(form.getValue());
});
```
