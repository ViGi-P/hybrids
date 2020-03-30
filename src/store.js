/* eslint-disable no-use-before-define, no-console */
import * as cache from "./cache.js";

/* istanbul ignore next */
try { process.env.NODE_ENV } catch(e) { var process = { env: { NODE_ENV: 'production' } }; } // eslint-disable-line

export const connect = `__store__connect__${Date.now()}__`;

const definitions = new WeakMap();
const _ = (h, v) => v;

// UUID v4 generator thanks to https://gist.github.com/jed/982883
function uuid(temp) {
  return temp
    ? // eslint-disable-next-line no-bitwise, no-mixed-operators
      (temp ^ ((Math.random() * 16) >> (temp / 4))).toString(16)
    : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, uuid);
}

function resolve(config, model, lastModel) {
  if (lastModel) definitions.set(lastModel, null);
  return model;
}

function resolveWithInvalidate(config, model, lastModel) {
  resolve(config, model, lastModel);

  if (error(model) || !lastModel) {
    config.invalidate();
  }

  return model;
}

function sync(config, id, model, invalidate) {
  cache.set(
    config,
    id,
    invalidate ? resolveWithInvalidate : resolve,
    model,
    true,
  );
  return model;
}

let currentTimestamp;
function getCurrentTimestamp() {
  if (!currentTimestamp) {
    currentTimestamp = Date.now();
    requestAnimationFrame(() => {
      currentTimestamp = undefined;
    });
  }
  return currentTimestamp;
}

const timestamps = new WeakMap();

function getTimestamp(model) {
  let timestamp = timestamps.get(model);

  if (!timestamp) {
    timestamp = getCurrentTimestamp();
    timestamps.set(model, timestamp);
  }

  return timestamp;
}

function setTimestamp(model) {
  timestamps.set(model, getCurrentTimestamp());
  return model;
}

function setupStorage(storage) {
  if (typeof storage === "function") storage = { get: storage };

  const result = { cache: true, ...storage };

  if (result.cache === false || result.cache === 0) {
    result.validate = cachedModel =>
      !cachedModel || getTimestamp(cachedModel) === getCurrentTimestamp();
  } else if (typeof result.cache === "number") {
    result.validate = cachedModel =>
      !cachedModel ||
      getTimestamp(cachedModel) + result.cache > getCurrentTimestamp();
  } else if (result.cache !== true) {
    throw TypeError(
      `Storage cache property must be a boolean or number: ${typeof result.cache}`,
    );
  }

  return Object.freeze(result);
}

function memoryStorage(config) {
  return {
    get: config.enumerable ? () => {} : () => config.create({}),
    set: () => {},
    list:
      config.enumerable &&
      function list(parameters) {
        if (parameters) {
          throw TypeError(
            `Memory-based model definition does not support parameters`,
          );
        }

        return cache.getEntries(config).reduce((acc, { key, value }) => {
          if (key === config) return acc;
          if (value && !error(value)) acc.push(key);
          return acc;
        }, []);
      },
  };
}

function bootstrap(Model, options) {
  if (Array.isArray(Model)) return setupListModel(Model[0], options);
  return setupModel(Model);
}

function getTypeConstructor(type, key) {
  switch (type) {
    case "string":
      return String;
    case "number":
      return Number;
    case "boolean":
      return Boolean;
    default:
      throw TypeError(
        `The value for the '${key}' array must be a string, number or boolean: ${type}`,
      );
  }
}

function setModelState(model, state, value = model) {
  cache.set(model, "state", _, { state, value }, true);
  return model;
}

const getState = (h, v = { state: "ready", value: v }) => v;
function getModelState(model) {
  return cache.get(model, "state", getState);
}

const configs = new WeakMap();
function setupModel(Model) {
  if (typeof Model !== "object" || Model === null) {
    throw TypeError(`Model definition must be an object: ${typeof Model}`);
  }
  let config = configs.get(Model);

  if (!config) {
    const storage = Model[connect];
    if (storage) delete Model[connect];

    let invalidatePromise;
    const placeholder = {};

    config = {
      model: Model,
      external: !!storage,
      enumerable: hasOwnProperty.call(Model, "id"),
      placeholder: () =>
        setModelState(Object.freeze(Object.create(placeholder)), "pending"),
      invalidate: () => {
        if (!invalidatePromise) {
          invalidatePromise = Promise.resolve().then(() => {
            cache.invalidate(config, config, true);
            invalidatePromise = null;
          });
        }
      },
    };

    config.storage = setupStorage(storage || memoryStorage(config, Model));

    const transform = Object.keys(Object.freeze(Model)).map(key => {
      Object.defineProperty(placeholder, key, {
        get() {
          throw Error(
            `Model instance is in ${
              getModelState(this).state
            } state - use store.pending(), store.error(), or store.ready() guards`,
          );
        },
        enumerable: true,
      });

      if (key === "id") {
        if (Model[key] !== true) {
          throw TypeError(
            `The 'id' property must be true or undefined: ${typeof Model[key]}`,
          );
        }
        return (model, data, lastModel) => {
          let id;
          if (lastModel) {
            id = lastModel.id;
          } else if (hasOwnProperty.call(data, "id")) {
            id = String(data.id);
          } else {
            id = uuid();
          }

          Object.defineProperty(model, "id", { value: id, enumerable: true });
        };
      }

      const type = typeof Model[key];
      const defaultValue = Model[key];

      switch (type) {
        case "function":
          return model => {
            Object.defineProperty(model, key, {
              get() {
                return cache.get(this, key, defaultValue);
              },
            });
          };
        case "object": {
          if (defaultValue === null) {
            throw TypeError(
              `The value for the '${key}' must be an object instance: ${defaultValue}`,
            );
          }

          const isArray = Array.isArray(defaultValue);

          if (isArray) {
            const nestedType = typeof defaultValue[0];

            if (nestedType !== "object") {
              const Constructor = getTypeConstructor(nestedType, key);
              const defaultArray = Object.freeze(defaultValue.map(Constructor));
              return (model, data, lastModel) => {
                if (hasOwnProperty.call(data, key)) {
                  if (!Array.isArray(data[key])) {
                    throw TypeError(
                      `The value for '${key}' property must be an array: ${typeof data[
                        key
                      ]}`,
                    );
                  }
                  model[key] = Object.freeze(data[key].map(Constructor));
                } else if (lastModel && hasOwnProperty.call(lastModel, key)) {
                  model[key] = lastModel[key];
                } else {
                  model[key] = defaultArray;
                }
              };
            }

            const localConfig = bootstrap(defaultValue, { nested: true });

            if (localConfig.enumerable && defaultValue[1]) {
              const nestedOptions = defaultValue[1];
              if (typeof nestedOptions !== "object") {
                throw TypeError(
                  `Options for '${key}' array property must be an object instance: ${typeof nestedOptions}`,
                );
              }
              if (nestedOptions.loose) {
                config.contexts = config.contexts || new Set();
                config.contexts.add(bootstrap(defaultValue[0]));
              }
            }
            return (model, data, lastModel) => {
              if (hasOwnProperty.call(data, key)) {
                if (!Array.isArray(data[key])) {
                  throw TypeError(
                    `The value for '${key}' property must be an array: ${typeof data[
                      key
                    ]}`,
                  );
                }
                model[key] = localConfig.create(data[key], true);
              } else {
                model[key] =
                  (lastModel && lastModel[key]) ||
                  (localConfig.enumerable
                    ? []
                    : localConfig.create(defaultValue));
              }
            };
          }

          const nestedConfig = bootstrap(defaultValue);
          if (nestedConfig.enumerable || nestedConfig.external) {
            return (model, data, lastModel) => {
              let resultModel;

              if (hasOwnProperty.call(data, key)) {
                const nestedData = data[key];

                if (typeof nestedData !== "object" || nestedData === null) {
                  if (nestedData !== undefined && nestedData !== null) {
                    resultModel = { id: nestedData };
                  }
                } else {
                  const dataConfig = definitions.get(nestedData);
                  if (dataConfig) {
                    if (dataConfig.model !== defaultValue) {
                      throw TypeError(
                        "Model instance must match the definition",
                      );
                    }
                    resultModel = nestedData;
                  } else {
                    resultModel = nestedConfig.create(nestedData);
                    sync(nestedConfig, resultModel.id, resultModel, true);
                  }
                }
              } else {
                resultModel = lastModel && lastModel[key];
              }

              if (resultModel) {
                const id = resultModel.id;
                let value;
                Object.defineProperty(model, key, {
                  get() {
                    if (pending(this)) return value;
                    value = get(defaultValue, id);
                    return value;
                  },
                  enumerable: true,
                });
              } else {
                model[key] = undefined;
              }
            };
          }

          return (model, data, lastModel) => {
            if (hasOwnProperty.call(data, key)) {
              model[key] = nestedConfig.create(
                data[key],
                lastModel && lastModel[key],
              );
            } else {
              model[key] = lastModel ? lastModel[key] : nestedConfig.create({});
            }
          };
        }
        // eslint-disable-next-line no-fallthrough
        default: {
          const Constructor = getTypeConstructor(type);
          return (model, data, lastModel) => {
            if (hasOwnProperty.call(data, key)) {
              model[key] = Constructor(data[key]);
            } else if (lastModel && hasOwnProperty.call(lastModel, key)) {
              model[key] = lastModel[key];
            } else {
              model[key] = defaultValue;
            }
          };
        }
      }
    });

    config.create = function create(data, lastModel) {
      if (data === null) return null;

      if (typeof data !== "object") {
        throw TypeError(`Model values must be an object: ${data}`);
      }

      const model = transform.reduce((acc, fn) => {
        fn(acc, data, lastModel);
        return acc;
      }, {});

      definitions.set(model, config);

      return Object.freeze(model);
    };

    Object.freeze(placeholder);

    configs.set(Model, Object.freeze(config));
  }

  return config;
}

const listPlaceholderPrototype = Object.getOwnPropertyNames(Array.prototype)
  .filter(key => !(key in Error.prototype))
  .reduce((acc, key) => {
    Object.defineProperty(acc, key, {
      get() {
        throw Error(
          `Model list in '${
            getModelState(this).state
          }' state - use store.pending() or store.error() guards`,
        );
      },
    });
    return acc;
  }, {});

const lists = new WeakMap();
function setupListModel(Model, options = { nested: false }) {
  let config = lists.get(Model);

  if (!config) {
    const modelConfig = setupModel(Model);

    const contexts = new Set();
    contexts.add(modelConfig);

    if (!options.nested) {
      if (!modelConfig.enumerable) {
        throw TypeError(
          "Listing model definition requires 'id' key set to `true`",
        );
      }
      if (!modelConfig.storage.list) {
        throw TypeError("Model definition storage must support `list` action");
      }
    }

    config = {
      model: Model,
      contexts,
      enumerable: modelConfig.enumerable,
      storage: setupStorage({
        cache: modelConfig.storage.cache,
        get:
          !options.nested &&
          (parameters => {
            return modelConfig.storage.list(parameters);
          }),
      }),
      placeholder: () =>
        setModelState(
          Object.freeze(Object.create(listPlaceholderPrototype)),
          "pending",
        ),
      create(items, invalidate) {
        const result = items.reduce((acc, data) => {
          let id = data;
          if (typeof data === "object" && data !== null) {
            id = data.id;
            const dataConfig = definitions.get(data);
            if (dataConfig) {
              if (dataConfig.model !== Model) {
                throw TypeError("Model instance must match the definition");
              }
            } else {
              const model = modelConfig.create(data);
              id = model.id;
              if (modelConfig.enumerable) {
                sync(modelConfig, id, model, invalidate);
              } else {
                acc.push(model);
              }
            }
          } else if (!modelConfig.enumerable) {
            throw TypeError(`Model instance must be an object: ${typeof data}`);
          }
          if (modelConfig.enumerable) {
            const key = acc.length;
            let value;
            Object.defineProperty(acc, key, {
              get() {
                if (pending(this)) return value;
                value = get(Model, id);
                return value;
              },
              enumerable: true,
            });
          }
          return acc;
        }, []);

        definitions.set(result, config);

        return Object.freeze(result);
      },
    };

    lists.set(Model, Object.freeze(config));
  }

  return config;
}

function resolveTimestamp(h, v) {
  return v || getCurrentTimestamp();
}

function stringifyParameters(parameters) {
  switch (typeof parameters) {
    case "object":
      return JSON.stringify(
        Object.keys(parameters)
          .sort()
          .reduce((acc, key) => {
            if (
              typeof parameters[key] === "object" &&
              parameters[key] !== null
            ) {
              throw TypeError(
                `You must use primitive value for '${key}' key: ${typeof parameters[
                  key
                ]}`,
              );
            }
            acc[key] = parameters[key];
            return acc;
          }, {}),
      );
    case "undefined":
      return undefined;
    default:
      return String(parameters);
  }
}

function mapError(model, err) {
  /* istanbul ignore next */
  if (process.env.NODE_ENV !== "production" && console.error) {
    console.error(err);
  }

  return setModelState(model, "error", err);
}

export function get(Model, parameters) {
  const config = bootstrap(Model);
  let id;

  if (!config.storage.get) {
    throw TypeError("Model definition storage must support 'get' method");
  }

  if (config.enumerable) {
    id = stringifyParameters(parameters);

    if (!config.contexts && !id) {
      throw TypeError(
        "Model definition with 'id' key requires non-empty parameters",
      );
    }
  } else if (parameters !== undefined) {
    throw TypeError(
      "Model definition must have 'id' key to support parameters",
    );
  }

  return cache.get(
    config,
    id,
    (h, cachedModel) => {
      if (cachedModel && pending(cachedModel)) return cachedModel;

      let validContexts = true;
      if (config.contexts) {
        config.contexts.forEach(context => {
          if (
            cache.get(context, context, resolveTimestamp) ===
            getCurrentTimestamp()
          ) {
            validContexts = false;
          }
        });
      }

      if (
        validContexts &&
        cachedModel &&
        (config.storage.cache === true || config.storage.validate(cachedModel))
      ) {
        return cachedModel;
      }

      try {
        let result = config.storage.get(parameters);

        if (typeof result !== "object" || result === null) {
          throw Error(
            `Model instance with '${id}' parameters not found: ${result}`,
          );
        }

        if (result instanceof Promise) {
          result = result
            .then(data => {
              if (typeof data !== "object" || data === null) {
                throw Error(
                  `Model instance with '${id}' parameters not found: ${data}`,
                );
              }

              data.id = id;
              return sync(config, id, config.create(data));
            })
            .catch(e => {
              sync(
                config,
                id,
                mapError(cachedModel || config.placeholder(), e),
              );
            });

          return setModelState(
            cachedModel || config.placeholder(),
            "pending",
            result,
          );
        }

        if (config.enumerable) result.id = id;

        if (cachedModel) definitions.set(cachedModel, null);
        return setTimestamp(config.create(result));
      } catch (e) {
        return setTimestamp(mapError(cachedModel || config.placeholder(), e));
      }
    },
    config.storage.validate,
  );
}

export function set(model, values = {}) {
  let config = definitions.get(model);
  const isInstance = !!config;

  if (config === null) {
    throw Error(
      "Provided model instance has expired. Haven't you used stale value from the outer scope?",
    );
  }

  if (!config) config = bootstrap(model);

  if (config.contexts) {
    throw TypeError("Listing models cannot be set");
  }

  if (!config.storage.set) {
    throw TypeError("Model definition storage must support 'set' method");
  }

  let id;
  let setState;

  try {
    if (!isInstance && (!values || typeof values !== "object")) {
      throw TypeError(`Values must be an object instance: ${values}`);
    }

    if (values && hasOwnProperty.call(values, "id")) {
      throw TypeError(`Values must not have 'id' property: ${values.id}`);
    }

    setState = (state, value) => {
      if (isInstance) {
        setModelState(model, state, value);
      } else {
        const entry = cache.getEntry(config, id);
        if (entry.value) {
          setModelState(entry.value, state, value);
        }
      }
    };

    const localModel = config.create(values, isInstance ? model : undefined);
    id = localModel ? localModel.id : model.id;

    const result = Promise.resolve(
      config.storage.set(isInstance ? id : undefined, localModel),
    )
      .then(data => {
        const resultModel = data ? config.create(data) : localModel;

        if (isInstance && resultModel && id !== resultModel.id) {
          throw TypeError(
            `Local and storage data must have the same id: '${id}', '${resultModel.id}'`,
          );
        }

        return sync(
          config,
          resultModel ? resultModel.id : id,
          resultModel ||
            mapError(
              config.placeholder(),
              Error(
                `Model instance with '${id}' parameters not found: ${resultModel}`,
              ),
            ),
          true,
        );
      })
      .catch(err => {
        err = err !== undefined ? err : Error("Undefined error");
        setState("error", err);
        throw err;
      });

    setState("pending", result);

    return result;
  } catch (e) {
    if (setState) setState("error", e);
    return Promise.reject(e);
  }
}

export function clear(model, clearValue = true) {
  if (typeof model !== "object" || model === null) {
    throw TypeError(
      `The first argument must be model instance or model definition: ${model}`,
    );
  }

  const config = definitions.get(model);

  if (config === null) {
    throw Error(
      "Provided model instance has expired. Haven't you used stale value from the outer scope?",
    );
  }

  if (config) {
    cache.invalidate(config, model.id, clearValue);
  } else {
    if (!configs.get(model) && !lists.get(model[0])) {
      throw Error(
        "Model definition must be used before - passed argument is probably not a model definition",
      );
    }
    cache.invalidateAll(bootstrap(model), clearValue);
  }
}

export function pending(model) {
  if (model === null || typeof model !== "object") return false;
  const { state, value } = getModelState(model);
  return state === "pending" && value;
}

export function error(model) {
  if (model === null || typeof model !== "object") return false;
  const { state, value } = getModelState(model);
  return state === "error" && value;
}

export function ready(model) {
  if (model === null || typeof model !== "object") return false;
  return !!definitions.get(model);
}

function mapValueWithState(lastValue, nextValue) {
  const result = Object.freeze(
    Object.keys(lastValue).reduce((acc, key) => {
      Object.defineProperty(acc, key, {
        get: () => lastValue[key],
        enumerable: true,
      });
      return acc;
    }, Object.create(lastValue)),
  );

  definitions.set(result, definitions.get(lastValue));

  const { state, value } = getModelState(nextValue);
  return setModelState(result, state, value);
}

export function store(Model, parameters) {
  const config = bootstrap(Model);
  const fn = typeof parameters === "function" ? parameters : h => h[parameters];

  return {
    get: (host, lastValue) => {
      if (parameters === undefined && config.enumerable && !config.contexts) {
        if (lastValue) {
          const { state, value } = getModelState(lastValue);
          if (state === "ready") {
            return store.get(Model, value.id);
          }
          return lastValue;
        }

        return null;
      }

      const nextValue = store.get(Model, fn(host));

      if (lastValue && nextValue !== lastValue && !ready(nextValue)) {
        return mapValueWithState(lastValue, nextValue);
      }

      return nextValue;
    },
    set: config.contexts
      ? undefined
      : (host, values, lastValue) => {
          if (parameters === undefined && config.enumerable) {
            if (values === undefined) return undefined;

            if (!lastValue) {
              const result = store.set(Model, values);
              const placeholder = setModelState(
                config.placeholder(),
                "pending",
                result,
              );

              result
                .then(model => {
                  setModelState(placeholder, "ready", model);
                })
                .catch(e => {
                  setModelState(placeholder, "error", e);
                });

              return placeholder;
            }
          }

          if (!lastValue) {
            lastValue = store.get(Model, fn(host));
          }
          if (pending(lastValue)) {
            throw Error("Model instance is in pending state");
          } else if (ready(lastValue)) {
            const result = store.set(lastValue, values);
            if (config.enumerable && parameters === undefined) {
              result.then(model => {
                setModelState(lastValue, "ready", model);
              });
            }
            result.catch(() => {});
          } else {
            throw Error(
              "Model instance is not initialized - you must get it first",
            );
          }

          return lastValue;
        },
  };
}

export default Object.assign(store, {
  get,
  set,
  clear,
  pending,
  error,
  ready,
  connect,
});
