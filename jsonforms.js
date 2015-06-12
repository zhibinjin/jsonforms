/* A Backbone base library for generating forms with json schema v4.
 *
 * Usage:
 * 1. create a FieldMap or Form instance with json schema.
 * 2. call render()
 * 3. call setValue() to set initial value.
 *
 * setValue, getValue can only be called after form is rendered.
 * This limitation is due to:
 *   values are stored in the html elements directly, fields, field maps, field lists, etc. 
 *
 * json schema extensions:
 *  1. ``editor``: indicate an editor type.  If omitted, best efforts will be
 *          tried to guess the appropriate editor type. schemas with an ``object`` or ``array`` type can
 *          also have ``editor`` property, where it's intended to use a customized editor for an object or array.
 *  2. ``optionLabels``: required when ``enum`` exists.  indicates the options labels.
 *  3. ``type: file``:
 *  4. ``inputAttributes``
 *  5. ``showOnly``
 *  6. ``serialize``, ``deserialize``, optional, for Field only.
 */

var jsonforms = (function(jsonforms) {
    "use strict";

    // convert camelCased string for display.
    // Examples:
    //      'htmlAttr' => 'Html Attr'
    //      'HTTPError' => 'HTTP Error'
    var prettify = function(s) {
        // js regexp doesn't support look-behind. 
        return (s || '').replace(/([^A-Z])([A-Z])/g, function($0, $1, $2) {
                return $1 + ' ' + $2;
            })
            .replace(/([A-Z])([A-Z])(?![A-Z]|$)/g, function($0, $1, $2) {
                return $1 + ' ' + $2;
            })
            .replace(/^[a-z]/, function($0) {
                return $0.toUpperCase();
            });
    };

    var issubclass = function(A, B) {
        if (!_.isFunction(A) || !_.isFunction(B)) throw new Error('Function parameter expected.');
        return A.prototype instanceof B || A === B;
    };

    // Examples regarded as empty:
    //   null, undefined, [], {}
    //   [null, undefined, [], {}]
    //   {a: null, b: undefined, c: [null, {d: [null, {}]}]}
    var isHierarchicalEmpty = function(obj) {
        if (obj == null) return true;
        if (_.isString(obj) || !_.isObject(obj)) return false;

        if (_.isArray(obj) || _.isArguments(obj)) {
            if (obj.length === 0) return true;
        } else if (_.keys(obj).length === 0) return true;

        return _.every(obj, function(value) {
            return isHierarchicalEmpty(value);
        });
    };

    var hasDataType = function(dataType, dataType2) {
        return dataType === dataType2 || (_.isArray(dataType) && _.contains(dataType, dataType2));
    };

    var createField = function(parent, schema, name, prefix) {
        if (!schema.type) throw new Error('missing required property ``type`` in schema.');

        var options = {
            name: name,
            prefix: prefix,
            parent: parent,
            templates: parent.templates,
            schema: schema
        };

        if (!schema.editor && schema.type === 'object')
            return new FieldMap(options);

        if (!schema.editor && schema.type === 'array')
            return new FieldList(options);

        return new Field(options);
    };

    var createEditor = function(schema, name, placeholder) {
        // browsers fall back to type=text when they don't undertand the type.
        // TODO: array with enum items => multi-select or checkboxes
        // TODO: type=file
        //
        // when an array item is moved/inserted/removed, the index of other items are changed in most cases. 
        // This will cause the id/name attributes to its items change.
        // So, to correctly implement id/name, an event broadcast mechanism is necessary. 
        // Currently, there is no such use case, so generate a random id here.
        var attributes = {},
            supportDate = $('<input type="date">')[0].type !== 'text',
            editorClassName;

        if (schema.editor) editorClassName = schema.editor;
        else if (schema['enum']) editorClassName = 'Select';
        else if (schema.type === 'boolean') editorClassName = 'Checkbox';
        else if (!supportDate && schema.format === 'date') editorClassName = 'DatePicker';
        else editorClassName = 'Text';

        var editorClass = jsonforms[editorClassName];

        if (schema.required) attributes.required = true;
        if (schema.readOnly) attributes.readonly = true;

        if (editorClass.prototype.tagName === 'input') {
            attributes.type = editorClass.prototype.type;

            // Attempting to change the type property (or attribute) of an input element created via HTML or already 
            // in an HTML document will result in an error being thrown by Internet Explorer 6, 7, or 8.
            // Here an editor is initialized(type changed) before being added into DOM.
            if (editorClass.prototype.type === 'text') {
                if (schema.type === 'integer' || schema.type === 'number') attributes.type = 'number';
                else if (schema.format === 'email') attributes.type = 'email';
                else if (schema.format === 'date') attributes.type = 'date';
                else if (schema.format === 'uri') attributes.type = 'url';

                if (_.has(schema, 'maxLength')) attributes.maxlength = schema.maxLength;
                if (_.has(schema, 'pattern')) attributes.pattern = schema.pattern;
                if (schema.multipleOf && (schema.minimum % schema.multipleOf === 0)) attributes.step = schema.multipleOf;
                //min, max can be set for not only for number input, but also for date input...
                if (_.has(schema, 'minimum')) attributes.min = schema.minimum;
                if (_.has(schema, 'maximum')) attributes.max = schema.maximum;
            }
        }

        if (placeholder) attributes.placeholder = placeholder;
        attributes = _.extend({
                id: _.uniqueId('id'),
                name: name
            },
            attributes, schema.inputAttributes);

        var options = {
            dataType: schema.type,
            inputAttributes: attributes, // Editor.el is not necessarily the input element.
            schema: schema
        };

        if (issubclass(editorClass, Select)) {
            var optionValues = schema['enum'].slice(),
                optionLabels = schema.optionLabels ? schema.optionLabels.slice() : optionValues.slice();
            if (_.isArray(schema.type) && _.contains(schema.type, 'null')) {
                optionValues.splice(0, 0, null);
                optionLabels.splice(0, 0, '');
            }
            options.options = _.map(_.zip(optionValues, optionLabels),
                function(option) {
                    return {
                        val: option[0],
                        label: option[1]
                    };
                });
        }
        return new editorClass(options);
    };

    var parseJsonPointer = function(s) {
        var tokens = s.split('/');
        if (tokens[0] !== '') throw new Error('unknown json pointer: ' + s);
        return _.map(tokens.slice(1), function(token) {
            if (/\d+/.test(token)) return parseInt(token, 10);
            return decodeURIComponent(token);
        });
    };

    jsonforms.getValueByJsonPointer = function(json, pointer) {
        if (!pointer) return json;

        var tokens = parseJsonPointer(pointer),
            value = json;
        for (var i = 0; i < tokens.length; i++) {
            if (value === null || value === undefined) return undefined;
            value = value[tokens[i]];
        }
        return value;
    };

    // when pointer points to a array item, return its innerField.
    var getField = function(root, pointer) {
        if (root instanceof ListItem) throw new Error("root can't be ListItem.");

        if (!pointer || pointer === '/') return root;

        var tokens = parseJsonPointer(pointer),
            current = root;

        for (var i = 0; i < tokens.length; i++) {
            if (current === undefined || (!current.fields && !current.items))
                throw new Error("can't find a field with Json Pointer `" + pointer + "`.");
            current = current.fields ? current.fields[tokens[i]] : current.items[tokens[i]].innerField;
        }
        if (!current) throw new Error("can't find a field with Json Pointer `" + pointer + "`.");
        return current;
    };

    var enumerateFields = function(rootField) {
        if (!rootField.fields && !rootField.items && !rootField.innerField) return [rootField];

        return [rootField].concat(
            _.flatten(
                _.map(rootField.fields || rootField.items || [rootField.innerField], function(field) {
                    return enumerateFields(field);
                })
            ));
    };

    var clearErrors = function(field) {
        var fields = enumerateFields(field);
        _.each(fields, function(field) {
            field.setError();
        });
    };

    var getFullName = function(prefix, name) {
        if (!prefix) return name || '';
        if (!name) return prefix || '';
        return prefix + '-' + name;
    };

    var Editor = jsonforms.Editor = Backbone.View.extend({

        initialize: function(options) {
            // id, class and other html attrs are set with id, className and attributes properties of options by Backbone.
            options = options || {};

            _.extend(this, {},
                _.pick(options, 'inputAttributes', 'dataType', 'schema'));
            if (!this.inputAttributes) this.inputAttributes = {};

            this.inputId = this.inputAttributes.id;
            this.inputName = this.inputAttributes.name;
        },

        events: {
            'change': function() {
                this.trigger('change', this);
            }
        },

        getValue: function() {
            throw new Error('not implemented');
        },

        setValue: function(value) { // jshint ignore: line
            throw new Error('not implemented');
        },

        render: function() {
            return this;
        }
    });


    var Field = jsonforms.Field = Backbone.View.extend({

        initialize: function(options) {
            options = options || {};

            _.extend(this, {
                name: '',
                prefix: '',
                templates: jsonforms.templates
            }, _.pick(options, 'name', 'prefix', 'parent', 'templates'));

            this.fullName = getFullName(this.prefix, this.name);

            this.schema = _.extend({
                    title: prettify(options.name),
                    description: ''
                },
                options.schema);
            // properties in schema: type, title, description, editor, template, inputAttributes, validation-related

            this.serialize = this.schema.serialize;
            this.deserialize = this.schema.deserialize;
        },

        render: function() {
            if (this.editor) this.editor.remove();

            var inArray = false,
                parent = this;
            while (parent)
                if ((parent = parent.parent) instanceof ListItem) {
                    inArray = true;
                    break;
                }

            var editor = this.editor = createEditor(this.schema, this.fullName, inArray ? this.schema.title : null);
            editor.on('change', function() {
                this.trigger('change', this);
            }, this);

            if (editor.hidden) return this.setElement(editor.render().el);

            var template = this.templates[this.schema.templateName || (inArray ? 'field-inline' : 'field')];

            var $field = $(template(_.defaults({
                editor: this.editor,
                fullName: this.fullName
            }, this.schema)));

            $field.find('[data-editor]')
                .add($field.filter('[data-editor]'))
                .eq(0)
                .append(editor.render().el);

            this.setElement($field);

            return this;
        },

        setError: function(msg) {
            if (msg !== null && msg !== undefined && !_.isString(msg))
                throw new Error('Field(name: ' + this.name + '): unexpected error message type.');
            if (msg) {
                this.$el.addClass(this.errorClassName);
                this.$('[data-error]').html(msg);
            } else {
                this.$el.removeClass(this.errorClassName);
                this.$('[data-error]').empty();
            }
        },

        getValue: function() {
            var value = this.editor.getValue();
            // both null and "" can pass "required" constraint in json schema validation.
            // properties with `undefined` value will be ignored during JSON.stringify,
            // however, items with `undefined` value in an array will be serialized to `null`.
            if (value == null || value === "") value = null;
            return this.deserialize ? this.deserialize(value) : value;
        },

        setValue: function(value) {
            this.editor.setValue(this.serialize ? this.serialize(value): value);
        },

        remove: function() {
            delete this.parent;
            this.editor.remove();
            Backbone.View.prototype.remove.call(this);
        }
    });


    var FieldMap = jsonforms.FieldMap = Backbone.View.extend({

        templateName: 'object',

        initialize: function(options) {
            options = options || {};

            var schema = this.schema = _.extend({
                    title: prettify(options.name),
                    description: ''
                },
                options.schema);

            _.each(schema.required || [], function(prop) {
                schema.properties[prop] = _.defaults({
                    required: true
                }, schema.properties[prop]);
            });

            _.extend(this, {
                name: '',
                prefix: '',
                templates: jsonforms.templates
            }, _.pick(options, 'name', 'prefix', 'parent', 'templates'));

            this.fullName = getFullName(this.prefix, this.name);

            var fieldNames = _.keys(this.schema.properties);

            // allFields: all fields specified in the schema
            // fields: fields that pass dependencies conditions.
            this.allFields = this.fields = _.object(
                _.map(fieldNames, function(name) {
                    return [name, createField(this, schema.properties[name], name, this.fullName)];
                }, this)
            );

            _.each(this.allFields, function(field) {
                field.on('change', function(field) {
                    this.ensureDependencies(field);
                    this.trigger('change', this);
                }, this);
            }, this);
        },

        render: function() {
            var fields = this.allFields;

            var template = this.templates[this.schema.templateName || this.templateName];

            var $content = $(template(this));
            this.$errorEl = $content.find('[data-error]');

            $content.find('[data-fields]').add($content.filter('[data-fields]')).each(function(i, el) {
                var $el = $(el),
                    selection = $el.attr('data-fields');

                var names = (selection == '*') ? _.keys(fields) : _.map(selection.split(','), $.trim);
                _.each(names, function(name) {
                    var field = fields[name].render();
                    if (!field.schema.availableIf) $el.append(field.el);  // conditional-exists fields ain't shown.
                });
            });
            $content.addClass(this.className);
            this.setElement($content);

            return this;
        },

        /* by defaults, null values are removed.

           sometimes null values have to be kept to notify other parties a change from non-null to null happens,
           because missing usually means no change happens.
           */
        getValue: function(options) {
            var keepNullValues = (options || {}).keepNullValues;

            var values = _.map(
                _.filter(this.fields, function(field) {
                    return !field.schema.showOnly;
                }), function(field) {
                    return [field.name, field.getValue(options)];
                });

            if (!keepNullValues)
                values = _.filter(values, function(nvp) {
                    return nvp[1] != null;
                });
            return _.object(values);
        },

        // by defaults, missing values won't be set.
        setValue: function(value, options) {
            var ignoreMissingValue = (options || {}).ignoreMissingValue;
            if (ignoreMissingValue === undefined) ignoreMissingValue = true;

            value = value || {};

            _.each(this.allFields, function(field, name) {
                if (!ignoreMissingValue || _.has(value, name)) field.setValue(value[name], options);
            });

            this.ensureDependencies();
        },

        ensureDependencies: function(changedField) {
            if (changedField !== undefined && _.every(this.allFields, function(field) {
                return !field.schema.availableIf || _.indexOf(_.keys(field.schema.availableIf), changedField.name) === -1;
            })) return;
            
            var allFields = this.allFields;
            var fields = this.fields = {};

            var isAvailable = function(field) {
                if (!field.schema.availableIf) return true;

                var kvp = _.pairs(field.schema.availableIf)[0], // kvp[0]: key, kvp[1]: testValue
                    // value should be got just before comparison in order for chain dependencies working correctly.
                    value = fields[kvp[0]] ? fields[kvp[0]].getValue() : undefined;

                if (_.isRegExp(kvp[1])) return kvp[1].test('' + (value == null ? '' : value));
                else if (hasDataType(field.schema.type, 'array')) return _.contains(value, kvp[1]);
                else return _.isEqual(value, kvp[1]);
            };

            _.each(this.allFields, function(f) {
                f.$el.detach();
            });

            this.$el.find('[data-fields]').add(this.$el.filter('[data-fields]')).each(function(i, el) {
                var $el = $(el),
                    selection = $el.attr('data-fields');

                var names = (selection == '*') ? _.keys(allFields) : _.map(selection.split(','), $.trim);
                _.each(names, function(name) {
                    var field = allFields[name];
                    if (isAvailable(field)) {
                        $el.append(field.el);
                        fields[name] = field;
                    } 
                });
            });
        },

        setError: function(error) {
            if (!error) {
                this.$errorEl.empty();
                this.$errorEl.removeClass(this.errorClassName);
            } else {
                this.$errorEl.html(error);
                this.$errorEl.addClass(this.errorClassName);
            }
        },

        remove: function() {
            delete this.parent;
            _.invoke(this.allFields, 'remove');
            return Backbone.View.prototype.remove.apply(this, arguments);
        }

    });


    var FieldList = Backbone.View.extend({

        events: {
            'click [data-action="add"]': function(event) {
                event.preventDefault();
                this.addItem();
            }
        },

        initialize: function(options) {
            options = options || {};

            _.extend(this, {
                name: '',
                prefix: '',
                templates: jsonforms.templates
            }, _.pick(options, 'name', 'prefix', 'parent', 'templates'));

            this.fullName = getFullName(this.prefix, this.name);

            this.schema = _.extend({
                    title: prettify(options.name),
                    description: ''
                },
                options.schema);

            this.items = [];
        },

        render: function() {
            var template = this.templates[this.schema.templateName || 'array'];
            var $el = $(template(this));

            this.$list = $el.is('[data-items]') ? $el : $el.find('[data-items]');
            this.$errorEl = $el.find('[data-error]');

            this.setElement($el);
            this.$el.attr('name', this.name);

            return this;
        },

        addItem: function(index) {
            if (index === undefined) index = this.items.length;

            var prefix = this.fullName + '-n';

            var item = new ListItem({
                parent: this,
                schema: this.schema.items, //only support items as a ``dict``.
                prefix: prefix, // ListItem has no name.  its fullName equals to its prefix.
                index: index //TODO: index will change dynamically?
            }).render();

            item.on('change', function() {
                this.trigger('change', this); 
            }, this);

            var $children = this.$list.children();
            if (index === $children.length) this.$list.append(item.el);
            else item.$el.insertBefore($children.eq(index));

            this.items.splice(index, 0, item);

            this.trigger('change:items', this);

            return item;
        },

        removeItem: function(item) {
            //Confirm delete
            //var confirmMsg = this.schema.confirmDelete;
            //if (confirmMsg && !confirm(confirmMsg)) return;

            var index = _.indexOf(this.items, item);

            this.items[index].remove();
            this.items.splice(index, 1);

            this.trigger('change:items', this);
        },

        moveUp: function(item) {
            var index = _.indexOf(this.items, item);
            if (index === 0) return;

            this.items[index].$el.detach().insertBefore(this.items[index - 1].$el);
            this.items.splice(index, 1);
            this.items.splice(index - 1, 0, item);

            this.trigger('change:items', this);
        },

        moveDown: function(item) {
            var index = _.indexOf(this.items, item);
            if (index >= this.items.length - 1) return;

            this.items[index].$el.detach().insertAfter(this.items[index + 1].$el); //this.items haven't change now.
            this.items.splice(index, 1);
            this.items.splice(index + 1, 0, item);

            this.trigger('change:items', this);
        },

        getValue: function(options) {
            return _.map(this.items, function(item) {
                return item.getValue(options);
            });
        },

        setValue: function(value, options) {
            _.each(this.items, function(item) {
                this.removeItem(item);
            }, this);

            _.each(value || [], function(itemValue) {
                this.addItem().setValue(itemValue, options);
            }, this);
        },

        setError: function(error) {
            if (!error) {
                this.$errorEl.empty();
                this.$errorEl.removeClass(this.errorClassName);
            } else {
                this.$errorEl.html(error);
                this.$errorEl.addClass(this.errorClassName);
            }
        },

        remove: function() {
            delete this.parent;
            _.invoke(this.items, 'remove');
            Backbone.View.prototype.remove.call(this);
        }
    });


    var ListItem = Backbone.View.extend({

        events: {
            'click [data-action="insert"]': function(event) {
                event.preventDefault();
                var index = _.indexOf(this.parent.items, this);
                this.parent.addItem(index);
            },
            'click [data-action="remove"]': function(event) {
                event.preventDefault();
                this.parent.removeItem(this);
            },
            'click [data-action="moveUp"]': function(event) {
                event.preventDefault();
                this.parent.moveUp(this);
            },
            'click [data-action="moveDown"]': function(event) {
                event.preventDefault();
                this.parent.moveDown(this);
            }
        },

        initialize: function(options) {
            options = options || {};
            _.extend(this, {
                prefix: '',
                templates: jsonforms.templates
            }, _.pick(options, 'parent', 'schema', 'prefix', 'index', 'templates'));

            this.fullName = this.prefix;
            this.innerField = createField(this, this.schema, '', this.prefix); // name of innerField is ''.

            this.innerField.on('change', function() {
                this.trigger('change', this); 
            }, this);

            this.parent.on('change:items', this.updateButtonState, this);
        },

        updateButtonState: function() {
            var index = _.indexOf(this.parent.items, this);

            this.$('[data-action^="move"]').removeClass('disabled');
            if (index === 0) this.$('[data-action="moveUp"]').addClass('disabled');
            // when there's only one item, both index === 0 and index === this.parent.items.length - 1 are correct.
            if (index === this.parent.items.length - 1) this.$('[data-action="moveDown"]').addClass('disabled');
        },

        render: function() {
            this.innerField.render();

            var template = this.templates[this.schema.templateName || 'item'];
            var $el = $(template(this));

            $el.find('[data-innerField]').html(this.innerField.el);
            this.setElement($el);

            return this;
        },

        getValue: function(options) {
            return this.innerField.getValue(options);
        },

        setValue: function(value, options) {
            this.innerField.setValue(value, options);
        },

        setError: function(err) {
            // ListItem's share the same Json Pointers with their innerField, that's why ``getField`` always return 
            // the innerField when a Json Pointer points to an array item.
            // This also means it's not practical to call setError to ListItem.
            if (!err) throw new Error('should setError for ListItem.'); // clearErrors may call it with no parameters.
        },

        remove: function() {
            delete this.parent;
            this.innerField.remove();
            Backbone.View.prototype.remove.call(this);
        }
    });


    var Text = jsonforms.Text = Editor.extend({

        tagName: 'input',
        type: 'text',

        render: function() {
            // id, name may change dynamically.
            this.$el.attr(this.inputAttributes);
            return this;
        },

        getValue: function() {
            var value = this.$el.val();

            if (value == null || value === '') return null;

            if (hasDataType(this.dataType, 'number')) {
                // when it's not a valid number, leave it as a string, so that the error can be caught in validation.
                if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) value = parseFloat(value);
            } else if (hasDataType(this.dataType, 'integer')) {
                if (/^[+-]?\d+$/.test(value)) value = parseInt(value, 10);
            }
            return value;
        },

        setValue: function(value) {
            this.$el.val((value === null || value === undefined) ? '' : value);
        }
    });


    var TextArea = jsonforms.TextArea = Text.extend({
        tagName: 'textarea'
    });


    var Checkbox = jsonforms.Checkbox = Editor.extend({

        tagName: 'input',
        type: 'checkbox',

        initialize: function(options) {
            Editor.prototype.initialize.call(this, options);
            this.$el.attr('type', 'checkbox');
        },

        render: function() {
            this.$el.attr(this.inputAttributes);
            return this;
        },

        getValue: function() {
            return this.$el.prop('checked');
        },

        setValue: function(value) {
            this.$el.prop('checked', value ? true : false);
        }
    });


    /**
     * Select editor
     *
     * Renders a <select> with given options
     *
     * Requires an 'options' value on the schema.
     *  Can be an array of options(eg. [{val: 1, label: 'something'}, ...]), a function
     *  or a Backbone collection in which models must implement a toString() method.
     *
     *  In single selection mode, when a value is undefined or missing, then it's regarded as null.
     */
    var Select = jsonforms.Select = Editor.extend({

        tagName: 'select',
        multiple: false,

        initialize: function(options) {
            Editor.prototype.initialize.call(this, options);
            this.options = this.normalizeOptions(options.options);

            // flatten option groups
            var flatten = function(options) {
                return _.map(options, function(option) {
                    if (option.group !== undefined) return flatten(option.options);
                    else return option;
                });
            };
            var flattenedOptions = _.flatten(flatten(this.options));

            this.optionValues = _.object(
                _.map(flattenedOptions,
                    function(option) {
                        return [option.val == null ? '' : '' + option.val, option.val];
                    })
            );
        },

        ensureValidValues: function(values) {
            _.each(_.isArray(values) ? values : [values], function(val) {
                if (!_.contains(this.optionValues, val))
                    throw new Error('invalid option value: ' + val);
            }, this);
        },

        render: function() {
            if (this.tagName === 'select' || this.tagName === 'input' || this.tagName === 'textarea')
                this.$el.attr(this.inputAttributes);
            this.$el.html(this._arrayToHtml(this.options));
            return this;
        },

        getValue: function() {
            var value = this.$el.val();
            if (this.multiple)
                return _.map(value, function(val) {
                    return this.optionValues[val || ''];
                }, this);
            return this.optionValues[value || ''];
        },

        setValue: function(value) {
            if (this.multiple && !_.isArray(value)) value = value == null ? [] : [value];
            if (!this.multiple && value === undefined) value = null;

            this.ensureValidValues(value)
            this.$el.val(value);
        },

        normalizeOptions: function(options) {
            if (_.isArray(options)) {
                return _.map(options, function(option) {
                    if (_.isString(option))
                        return {
                            val: option,
                            label: option
                        };
                    else if (_.isObject(option))
                        return option.group ? {
                            group: option.group,
                            options: this.normalizeOptions(option.options)
                        } : option;
                }, this);
            } else if (options instanceof Backbone.Collection) {
                return options.map(function(model) {
                    return {
                        val: model.id,
                        label: model.toString()
                    };
                });
            } else {
                // options is an object like { guest: 'Guest', admin: 'Administrator'}
                return _.map(options, function(value, key) {
                    return {
                        val: key,
                        label: value
                    };
                });
            }
        },

        /**
         * generate the <option> HTML
         * @param {Array}: an array of objects, e.g. [{val: 543, label: 'Title for object 543'}]
         * @return {String} HTML
         */
        _arrayToHtml: function(array) {
            return _.map(array, function(option) {
                if (option.group) {
                    return '<optgroup label="' + _.escape(option.group) + '">' + this._arrayToHtml(option.options) + '</optgroup>';
                } else {
                    var val = (option.val || option.val === 0) ? option.val : '';
                    return '<option value="' + _.escape(val) + '">' + _.escape(option.label) + '</option>';
                }
            }, this).join('\n');
        }
    });

    // Renders a <ul> with given options represented as checkboxes in <li>.
    var Checkboxes = jsonforms.Checkboxes = Select.extend({

        tagName: 'ul',
        multiple: true,

        getValue: function() {
            var values = this.$('input:checkbox:checked').map(function() {
                return $(this).val();
            });
            return _.map(values, function(value) {
                return this.optionValues[value || ''];
            }, this);
        },

        setValue: function(values) {
            if (!_.isArray(values)) values = values == null ? [] : [values];

            this.ensureValidValues(values)
            this.$('input:checkbox').val(values);
        },

        liTpl: _.template(['<li>',
            '<input type="checkbox" name="<%- name %>" value="<%- val %>" id="<%- id %>" />',
            '<label for="<%- id %>"><%- label %></label>',
            '</li>'
        ].join('\n')),

        _arrayToHtml: function(array) {
            return array.length === 0 ? '-' : _.map(array, function(option, index) {
                return this.liTpl({
                    name: this.name,
                    val: (option.val || option.val === 0) ? option.val : '',
                    id: this.id + '-' + index,
                    label: option.label
                });
            }, this).join('\n');
        }

    });


    var Radio = jsonforms.Radio = Select.extend({

        tagName: 'ul',
        multiple: false,

        getValue: function() {
            var value = this.$('input:radio:checked').val();
            return this.optionValues[value || ''];
        },

        setValue: function(value) {
            if (value === undefined) value = null;
            this.ensureValidValues(value)
            this.$('input:radio').val([value]);
        },

        _arrayToHtml: function(array) {
            var items = _.map(array, function(option, index) {
                return {
                    name: this.inputName,
                    id: this.inputId + '-' + index,
                    value: (option.val || option.val === 0) ? option.val : '',
                    label: option.label
                };
            }, this);

            return this.template({
                items: items
            });
        },

        template: _.template(['<% _.each(items, function(item) { %>',
            '<li>',
            '<input type="radio" name="<%- item.name %>" value="<%- item.value %>" id="<%- item.id %>" />',
            '<label for="<%- item.id %>"><%- item.label %></label>',
            '</li>',
            '<% }); %>'
        ].join('\n'))
    });


    var HiddenJson = jsonforms.HiddenJson = Editor.extend({
        hidden: true,
        className: 'hidden',

        getValue: function() {
            return this.value;
        },

        setValue: function(value) {
            this.value = value;
        }
    });


    var Hidden = jsonforms.Hidden = Text.extend({
        type: 'hidden',
        hidden: true
    });


    var Password = jsonforms.Password = Text.extend({
        type: 'password'
    });


    var ReadOnlyText = jsonforms.ReadOnlyText = Editor.extend({
        getValue: function() {
            return this.value;
        },

        setValue: function(value) {
            this.value = value;
            this.render();
        },

        _render_func: 'text',

        render: function() {
            this.$el[this._render_func](this.value);
            return this;
        }
    });


    var ReadOnlyHtml = jsonforms.ReadOnlyHtml = ReadOnlyText.extend({
        _render_func: 'html'
    });


    var DatePicker = jsonforms.DatePicker = Text.extend({
        render: function() {
            // Call the parent's render method
            Text.prototype.render.call(this);
            // Then make the editor's element a datepicker.
            this.$el.datepicker({
                format: 'yyyy-mm-dd',
                autoclose: true,
                weekStart: 1
            });

            return this;
        },

        setValue: function(value) {
            this.$el.val(value); //moment(value).format('YYYY-MM-DD'));
        },

        remove: function() {
            this.$el.datepicker('remove');
            Text.prototype.remove.apply(this, arguments);
        }
    });


    var TinyMCE = jsonforms.TinyMCE = TextArea.extend({

        render: function() {
            TextArea.prototype.render.call(this);

            var self = this;
            _.defer(function() {
                // tinymce.init must be called after el is added into DOM.
                tinymce.init({
                    selector: '#' + self.inputId,
                    setup: function(ed) {
                        ed.on('change', function(e) {
                            self.$el.val(e.target.getContent());
                        });
                    }
                });
            });

            return this;
        },

        getValue: function() {
            return tinymce.get(this.inputId) ? tinymce.get(this.inputId).getContent() : this.$el.val();
        },

        setValue: function(value) {
            this.$el.val(value);
            var ed = tinymce.get(this.inputId);
            // when setValue is called after the editor is rendered and before tinymce.init is called, `ed` is null.
            // tinymce will read initial text from textarea when it's initialized.
            if (ed) ed.setContent(value || ''); // when value is undefined, tinymce will fail.
        },

        remove: function() {
            tinymce.remove('#' + this.inputId);
            TextArea.prototype.remove.apply(this, arguments);
        }
    });

    var MultiImages = jsonforms.MultiImages = Editor.extend({
        itemTemplate: _.template('<li><span class="close">&times;</span><img class="thumbnail" src="<%- image %>"></li>'),
        maxItems: 10000,

        initialize: function(options) {
            Editor.prototype.initialize.apply(this, arguments);
            this.images = [];
            this.maxItems = this.schema.maxItems !== undefined ? this.schema.maxItems : this.maxItems;
        },

        events: {
            'change input[type=file]': function(e) {
                // `change` event should be triggered after uploading is finished.

                var files = e.currentTarget.files;

                if (!files.length) return;  // files: FileList, item: File
                
                var self = this;

                var dfd = $.Deferred(),
                    nextDfd = dfd;

                var upload = function(f) { // without this wrapper function, when uploadFile is called, the `f` is the last value in loop.
                    nextDfd = nextDfd.then(function() {
                        return self.uploadFile(f, {
                            url: self.inputAttributes.uploadUrl
                        }).done(function(data) {
                            self.addPhoto(data);
                        })
                    });
                };

                // ensure files are uploaded sequentially.
                // TODO: disable input when uploading is going on.
                var max = this.numUploadAllowed();
                for (var i = 0, f; (f = files[i]) && i < max; i++) {
                     // Only process image files.
                     if (!f.type.match('image.*')) continue;
                     upload(f)
                }
                dfd.resolve();
            },

            'click .close': function(e) {
                var $li = $(e.currentTarget).closest('li');
                var i = $li.parent().children().index($li);
                this.images.splice(i, 1);
                $li.remove();
                this.checkState();
            }
        },

        numUploadAllowed: function() {
            return this.maxItems - this.images.length;
        },

        // @param file: a File instance(retrieved by, for example, ``$('input[type=file]')[0].files[0]``)
        // @param options: jQuery ajax options
        uploadFile: function (file, options) {
            // as to IE, only works on IE10+
            // https://github.com/francois2metz/html5-formdata -- a FormData emulation
            var data = new FormData();
            data.append(file.name, file);
            // Setting processData to false to prevent jQuery from automatically transforming the data into a query string.
            // Setting the contentType to false is imperative, since otherwise jQuery will set it incorrectly.
            return $.ajax(_.defaults({
                type: 'POST',
                data: data,
                processData: false,
                cache: false,
                contentType: false
            }, options));
        },

        getValue: function() {
            return this.images;
        },

        addPhoto: function(value) {
            if (!value) return;
            
            if (this.images.length >= this.maxItems) return;
            this.images.push(value);

            this.$('ul').append(this.itemTemplate({
                image: value
            }));
            this.checkState();
            this.trigger('change', this); 
        },

        setValue: function(value) {
            this.images = _.isArray(value) ? value : (value ? [value] : []);
            this.images = this.images.slice(0, this.maxItems);
            this.renderPhotos();
        },

        render: function() {
            this.$el.html('<input type="file" accept="image/*"' + (this.maxItems === 1 ? '' : ' multiple') + '>');
            this.$el.attr(_.omit(this.inputAttributes, 'uploadUrl'));
            this.renderPhotos();
            return this;
        },

        renderPhotos: function() {
            this.$('ul').remove();

            var $ul = $('<ul class="list-inline"></ul>');
            _.each(this.images, function(image) {
                $ul.append(this.itemTemplate({image: image}));
            }, this);

            this.$el.append($ul);
            this.checkState();
            return this;
        },

        checkState: function() {
            this.$('input[type=file]').prop('disabled', this.images.length >= this.maxItems);
        }
    });


    var Image = jsonforms.Image = MultiImages.extend({
        maxItems: 1,

        getValue: function() {
            return this.images.length === 0 ? null : this.images[0];
        },
    
        numUploadAllowed: function() {
            return 1;
        },

        checkState: function() {
        },

        addPhoto: function(value) {
            this.setValue(value);
            this.trigger('change', this); 
        }
    });


    var Form = jsonforms.Form = FieldMap.extend({
        templateName: 'form',

        events: {
            // when any required constraint is not satisfied, submit won't be triggered 
            // even if <CR> is pressed or submit button is click.
            // however, click will be triggered in the both cases.
            submit: function(e) {
                e.preventDefault();
                var key = this._clicked;  // both e.currentTarget and e.target point to the form.
                this.trigger('submit', key);
            },
            'click .form-footer .btn': function(e) {
                // pressing Enter in a text field causes a click event on the first submit button in tree order occurs.
                //e.preventDefault();  // e.preventDefault will prevent generating submit event.
                var key = $(e.currentTarget).attr('value');
                if ($(e.currentTarget).attr('type') == 'submit') this._clicked = key;
                var buttonInfo = this.buttons[key];
                if (buttonInfo.callback) buttonInfo.callback.call(this, key);
                this.trigger(buttonInfo.event ? buttonInfo.event : 'action:' + key);
            },
            'mouseenter .help-inline[data-error]': function(e) {
                // when the error message for an inline field is too long, show a title.
                var el = e.currentTarget,
                    $el = $(el);

                if (el.offsetWidth < el.scrollWidth) {
                    $el.attr('title', $el.text());
                } else {
                    $el.attr('title', '');
                }
            }
        },

        initialize: function(options) {
            options = options || {};
            this.originalSchema = JSON.parse(JSON.stringify(options.schema));

            var buttons = _.extend({}, options.buttons);
            _.each(buttons, function(button, key) {
                if (_.isString(button))
                    buttons[key] = {
                        text: button
                    };
            });
            this.buttons = buttons;

            var submitBtns = _.filter(buttons, function(btn) {
                return btn.type === 'submit';
            });
            if (buttons.length > 0 && submitBtns.length === 0) throw new Error('no submit button');

            FieldMap.prototype.initialize.call(this, options);
        },

        setErrors: function(errors, options) {
            options = options || {};
            var pointerAttrName = options.pointerAttrName || 'dataPath';
            var messageAttrName = options.messageAttrName || 'message';

            this.clearErrors();

            if (!errors || errors.length === 0) return;

            // merge errors with same dataPath
            var errorGroups = _.groupBy(errors, function(err) {
                var pointer = err[pointerAttrName];
                return pointer === '' ? '/' : pointer;
            });

            _.each(errorGroups, function(errors, pointer) {
                var message;
                if (errors.length === 1) {
                    message = errors[0][messageAttrName];
                } else {
                    var messages = _.map(errors, function(err) {
                        return err[messageAttrName];
                    });

                    message = jsonforms.templates.errors({
                        errors: messages
                    });
                }

                getField(this, pointer).setError(message);
            }, this);
        },

        clearErrors: function() {
            clearErrors(this);
        },

        // validate with tv4, return whether it's valid or not, errors is saved in form.lastErrors.
        // @param optional.schema: optional, use form.originalSchema if not provided.
        // @param optional.showErrors: optional, default is false. 
        validate: function(options) {
            options = options || {};

            var result = tv4.validateMultiple(this.getValue(), options.schema || this.originalSchema);
            this.lastErrors = result.errors;

            if (options.showErrors && !result.valid) this.setErrors(result.errors);
            return result.valid;
        }
    });

    /**
     * Bootstrap 3 templates
     */
    var templates = jsonforms._templates = {
        'form-horizontal': _.template([
            '<form class="form-horizontal" role="form">',
            '  <div data-fields="*"></div>',
            '  <div class="col-sm-offset-2 col-sm-10">',
            '    <p class="help-block" data-error></p>',
            '  </div>',
            '  <div class="form-footer form-group">',
            '    <div class="col-sm-offset-2 col-sm-10">',
            '    <% for (key in buttons) { %>',
            '      <button type="<%- buttons[key].type || "button" %>" class="btn <%- buttons[key].className || (buttons[key].type !== "submit" ? "btn-default" : "btn-primary") %>" value="<%- key %>"><%- buttons[key].text %></button>&nbsp;',
            '    <% } %>',
            '    </div>',
            '  </div>',
            '</form>'
        ].join('\n')),

        'form-vertical': _.template([
            '<form role="form">',
            '  <div data-fields="*"></div>',
            '  <p class="help-block" data-error></p>',
            '  <div class="form-footer">',
            '  <% for (key in buttons) { %>',
            '    <button type="<%- buttons[key].type || "button" %>" class="btn <%- buttons[key].className || (buttons[key].type !== "submit" ? "btn-default" : "btn-primary") %>" value="<%- key %>"><%- buttons[key].text %></button>&nbsp;',
            '  <% } %>',
            '  </div>',
            '</form>'
        ].join('\n')),

        'form-inline': _.template([
            '<form class="form-inline" role="form">',
            '  <div data-fields="*"></div>',
            '</form>'
        ].join('\n')),

        'object-horizontal': _.template([
            '<div data-field="<%- fullName %>">',
            '  <div data-fields="*"></div>',
            '  <div class="clearfix"></div>',
            '  <div class="col-sm-offset-2 col-sm-10">',
            '  <p class="help-block" data-error></p>',
            '  </div>',
            '</div>'
        ].join('\n')),

        'object-vertical': _.template([
            '<div data-field="<%- fullName %>">',
            '  <div data-fields="*"></div>',
            '  <div class="clearfix"></div>',
            '  <p class="help-block" data-error></p>',
            '</div>'
        ].join('\n')),

        'object-inline': _.template('<span data-fields="*"></span>'),

        'field-horizontal': _.template([
            '<div class="form-group" data-field="<%- fullName %>">',
            '<% if (editor instanceof jsonforms.Checkbox) { %>',
            ' <div class="col-sm-offset-2 col-sm-10">',
            '  <div class="checkbox">',
            '   <label> <span data-editor></span> <%- title %> </label>',
            '  </div>',
            ' </div>',
            '<% } else { %>',
            ' <label class="col-sm-2 control-label" for="<%- editor.inputId %>"><%- title %></label>',
            ' <div class="col-sm-10">',
            '  <span data-editor></span>',
            '<% } %>',
            '  <p class="help-block" data-error></p>',
            '  <p class="help-block"><%- description %></p>',
            ' </div>',
            '</div>'
        ].join('\n')),

        'field-vertical': _.template([
            '<% if (editor instanceof jsonforms.Checkbox) { %>',
            '<div class="checkbox" data-field="<%- fullName %>">',
            '  <div class="checkbox">',
            '  <label for="<%- editor.inputId %>" >',
            '  <span data-editor></span> <%- title %>',
            '  </label>',
            '  </div>',
            '<% } else { %>',
            '<div class="form-group" data-field="<%- fullName %>">',
            '  <label for="<%- editor.inputId %>"><%- title %></label>',
            '  <span data-editor></span>',
            '<% } %>',
            '<p class="help-block" data-error></p>',
            '<p class="help-block"><%- description %></p>',
            '</div>'
        ].join('\n')),

        'field-inline': _.template([
            '<div class="form-group" data-field="<%- fullName %>">',
            '<div title="<%- title %>">',
            '  <span data-editor></span>',
            '  <div class="help-inline" data-error></div>',
            '</div>',
            '</div>'
        ].join('\n')),

        'array-horizontal': _.template([
            '<div class="jsonforms-array" data-field="<%- fullName %>">',
            '<ul class="form-inline list-unstyled clearfix" data-items></ul>',
            '<button type="button" class="btn btn-xs" data-action="add"><span class="glyphicon glyphicon-plus"></span> Add</button>',
            '<p class="help-block col-sm-offset-2 sol-sm-10" data-error></p>',
            '</div>'
        ].join('\n')),

        'array-vertical': _.template([
            '<div class="jsonforms-array" data-field="<%- fullName %>">',
            '<ul class="form-inline list-unstyled clearfix" data-items></ul>',
            '<button type="button" class="btn btn-xs" data-action="add"><span class="glyphicon glyphicon-plus"></span> Add</button>',
            '<p class="help-block" data-error></p>',
            '</div>'
        ].join('\n')),

        item: _.template([
            '<li class="clearfix jsonforms-item" data-field="item--<%- fullName %>">',
            '<div class="pull-left" data-innerField></div>',
            '&nbsp; <a class="btn btn-xs" data-action="insert"><span class="glyphicon glyphicon-plus"></span></a>',
            '<a class="btn btn-xs" data-action="remove"><span class="glyphicon glyphicon-remove"></span></a>',
            '&nbsp;<a class="btn btn-xs" data-action="moveUp"><span class="glyphicon glyphicon-arrow-up"></span></a>',
            '<a class="btn btn-xs" data-action="moveDown"><span class="glyphicon glyphicon-arrow-down"></span></a>',
            '</li>'
        ].join('\n')),

        errors: _.template([
            '<ul>',
            '<% for (var i = 0; i < errors.length; i++) { %>',
            ' <li><%- errors[i] %></li>',
            '<% } %>',
            '</ul>'
        ].join('\n'))
    };

    var horizontalTemplates = jsonforms.horizontalTemplates = _.defaults({
        form: templates['form-horizontal'],
        field: templates['field-horizontal'],
        object: templates['object-horizontal'],
        array: templates['array-horizontal']
    }, templates);

    var verticalTemplates = jsonforms.verticalTemplates = _.defaults({
        form: templates['form-vertical'],
        field: templates['field-vertical'],
        object: templates['object-vertical'],
        array: templates['array-vertical']
    }, templates);

    var inlineTemplates = jsonforms.inlineTemplates = _.defaults({
        form: templates['form-inline'],
        field: templates['field-inline'],
        object: templates['object-inline']
    }, templates);

    jsonforms.templates = verticalTemplates;

    // editor className
    Editor.prototype.className = 'form-control';

    Checkboxes.prototype.className = 'list-inline checkboxes';
    Checkbox.prototype.className = 'list-inline';
    Radio.prototype.className = 'list-inline radios';
    MultiImages.prototype.className = 'multi-images';
    ReadOnlyText.prototype.className = 'control-label readonly-text';

    // errorClassName
    Field.prototype.errorClassName = 'has-error';
    FieldMap.prototype.errorClassName = 'has-error';
    FieldList.prototype.errorClassName = 'has-error';
    ListItem.prototype.errorClassName = 'has-error';
    
    return jsonforms;

})(jsonforms || {});
