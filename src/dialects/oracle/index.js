// Oracle Client
// -------
import { assign, map, flatten, values } from 'lodash';

import inherits from 'inherits';
import Client from '../../client';
import Promise from 'bluebird';
import { bufferToString } from '../../query/string';
import Formatter from './formatter';

import Transaction from './transaction';
import QueryCompiler from './query/compiler';
import SchemaCompiler from './schema/compiler';
import ColumnBuilder from './schema/columnbuilder';
import ColumnCompiler from './schema/columncompiler';
import TableCompiler from './schema/tablecompiler';
import { ReturningHelper } from './utils';

// Always initialize with the "QueryBuilder" and "QueryCompiler"
// objects, which extend the base 'lib/query/builder' and
// 'lib/query/compiler', respectively.
export default function Client_Oracle(config) {
  Client.call(this, config);
}
inherits(Client_Oracle, Client);

assign(Client_Oracle.prototype, {
  dialect: 'oracle',

  driverName: 'oracle',

  _driver() {
    return require('oracle');
  },

  transaction() {
    return new Transaction(this, ...arguments);
  },

  formatter() {
    return new Formatter(this, ...arguments);
  },

  queryCompiler() {
    return new QueryCompiler(this, ...arguments);
  },

  schemaCompiler() {
    return new SchemaCompiler(this, ...arguments);
  },

  columnBuilder() {
    return new ColumnBuilder(this, ...arguments);
  },

  columnCompiler() {
    return new ColumnCompiler(this, ...arguments);
  },

  tableCompiler() {
    return new TableCompiler(this, ...arguments);
  },

  prepBindings(bindings) {
    return map(bindings, (value) => {
      // returning helper uses always ROWID as string
      if (value instanceof ReturningHelper && this.driver) {
        return new this.driver.OutParam(this.driver.OCCISTRING);
      } else if (typeof value === 'boolean') {
        return value ? 1 : 0;
      } else if (Buffer.isBuffer(value)) {
        return bufferToString(value);
      }
      return value;
    });
  },

  // Get a raw connection, called by the `pool` whenever a new
  // connection needs to be added to the pool.
  acquireRawConnection() {
    return new Promise((resolver, rejecter) => {
      this.driver.connect(
        this.connectionSettings,
        (err, connection) => {
          if (err) return rejecter(err);
          Promise.promisifyAll(connection);
          if (this.connectionSettings.prefetchRowCount) {
            connection.setPrefetchRowCount(
              this.connectionSettings.prefetchRowCount
            );
          }
          resolver(connection);
        }
      );
    });
  },

  // Used to explicitly close a connection, called internally by the pool
  // when a connection times out or the pool is shutdown.
  destroyRawConnection(connection) {
    return Promise.fromCallback(connection.close.bind(connection));
  },

  // Return the database for the Oracle client.
  database() {
    return this.connectionSettings.database;
  },

  // Position the bindings for the query.
  positionBindings(sql) {
    let questionCount = 0;
    return sql.replace(/\?/g, function() {
      questionCount += 1;
      return `:${questionCount}`;
    });
  },

  _stream(connection, obj, stream, options) {
    return new Promise(function(resolver, rejecter) {
      stream.on('error', (err) => {
        if (isConnectionError(err)) {
          connection.__knex__disposed = err;
        }
        rejecter(err);
      });
      stream.on('end', resolver);
      const queryStream = connection.queryStream(
        obj.sql,
        obj.bindings,
        options
      );
      queryStream.pipe(stream);
      queryStream.on('error', function(error) {
        rejecter(error);
        stream.emit('error', error);
      });
    });
  },

  // Runs the query on the specified connection, providing the bindings
  // and any other necessary prep work.
  _query(connection, obj) {
    if (!obj.sql) throw new Error('The query is empty');

    return connection
      .executeAsync(obj.sql, obj.bindings)
      .then(function(response) {
        if (!obj.returning) return response;
        const rowIds = obj.outParams.map(
          (v, i) => response[`returnParam${i ? i : ''}`]
        );
        return connection.executeAsync(obj.returningSql, rowIds);
      })
      .then(function(response) {
        obj.response = response;
        obj.rowsAffected = response.updateCount;
        return obj;
      })
      .catch((err) => {
        if (isConnectionError(err)) {
          connection.__knex__disposed = err;
        }
        throw err;
      });
  },

  // Process the response as returned from the query.
  processResponse(obj, runner) {
    let { response } = obj;
    const { method } = obj;
    if (obj.output) return obj.output.call(runner, response);
    switch (method) {
      case 'select':
      case 'pluck':
      case 'first':
        if (obj.method === 'pluck') response = map(response, obj.pluck);
        return obj.method === 'first' ? response[0] : response;
      case 'insert':
      case 'del':
      case 'update':
      case 'counter':
        if (obj.returning) {
          if (obj.returning.length > 1 || obj.returning[0] === '*') {
            return response;
          }
          // return an array with values if only one returning value was specified
          return flatten(map(response, values));
        }
        return obj.rowsAffected;
      default:
        return response;
    }
  },
});

// If the error is any of these, we'll assume we need to
// mark the connection as failed
const connectionErrors = [
      'ORA-03114', // not connected to ORACLE
      'ORA-03113', // end-of-file on communication channel
      'ORA-03135', // connection lost contact
      'ORA-12514', // listener does not currently know of service requested in connect descriptor
      'ORA-22', // invalid session ID; access denied
      'ORA-28', // your session has been killed
      'ORA-31', // your session has been marked for kill
      'ORA-45', // your session has been terminated with no replay
      'ORA-378', // buffer pools cannot be created as specified
      'ORA-602', // internal programming exception
      'ORA-603', // ORACLE server session terminated by fatal error
      'ORA-609', // could not attach to incoming connection
      'ORA-1012', // not logged on
      'ORA-1041', // internal error. hostdef extension doesn't exist
      'ORA-1043', // user side memory corruption
      'ORA-1089', // immediate shutdown or close in progress
      'ORA-1092', // ORACLE instance terminated. Disconnection forced
      'ORA-2396', // exceeded maximum idle time, please connect again
      'ORA-3122', // attempt to close ORACLE-side window on user side
      'ORA-12153', // TNS'not connected
      'ORA-12537', // TNS'connection closed
      'ORA-12547', // TNS'lost contact
      'ORA-12570', // TNS'packet reader failure
      'ORA-12583', // TNS'no reader
      'ORA-27146', // post/wait initialization failed
      'ORA-28511', // lost RPC connection
      'ORA-56600', // an illegal OCI function call was issued
      'NJS-040',
      'NJS-024',
      'NJS-003',
];

function isConnectionError(err) {
  return connectionErrors.some((prefix) => err.message.indexOf(prefix) === 0);
}
