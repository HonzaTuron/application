
"use strict";

var express   = require('express'),
    router    = express.Router(),
    Promise   = require('bluebird'),
    moment    = require('moment'),
    request   = require('request'),
    validator = require('validator'),
    _         = require('underscore'),
    EmailTransport  = require('../email');

router.get('/', function(req, res){

    Promise.join(
        req.user.promise_my_active_leaves_ever(),
        req.user.promise_leaves_to_be_processed(),
        function(my_leaves, to_be_approved_leaves){

            res.render('requests',{
                my_leaves             : my_leaves,
                to_be_approved_leaves : to_be_approved_leaves,
            });
        }
    );
});

function leave_request_action(args) {
    var
      current_action      = args.action,
      leave_action_method = args.leave_action_method,
      was_pended_revoke   = false;

    return function(req, res){

    var request_id = validator.trim( req.param('request') );

    if (!validator.isNumeric(request_id)){
      req.session.flash_error('Failed to ' + current_action);
    }

    if ( req.session.flash_has_errors() ) {
      console.error('Got validation errors on '+current_action+' request handler');

      return res.redirect_with_session('../');
    }

    Promise.try(function(){
      return req.user.promise_leaves_to_be_processed();
    })
    .then(function(leaves){
       var leave_to_process = _.find(leaves, function(leave){
          return String(leave.id) === String(request_id)
            && (leave.is_new_leave() || leave.is_pended_revoke_leave());
       });

       if (! leave_to_process) {
         throw new Error('Provided ID '+request_id
           +'does not correspond to any leave requests to be '+current_action
           +'ed for user ' + req.user.id
          );
       }

       was_pended_revoke = leave_to_process.is_pended_revoke_leave();

       return leave_to_process[leave_action_method]();
    })
    .then(function(processed_leave){
      return processed_leave.reload({
        include : [
          {model : req.app.get('db_model').User, as : 'user'},
          {model : req.app.get('db_model').User, as : 'approver'},
          {model : req.app.get('db_model').LeaveType, as : 'leave_type' },
        ],
      });
    })
    .then(function(processed_leave){

      var Email = new EmailTransport();

      return Email.promise_leave_request_decision_emails({
        leave             : processed_leave,
        action            : current_action,
        was_pended_revoke : was_pended_revoke,
      })
      .then(function(){
        return Promise.resolve( processed_leave);
      });
    })
    .then(function(processed_leave){
      req.session.flash_message('Request from '+processed_leave.user.full_name()
          +' was '+current_action+'ed');

      return res.redirect_with_session('../');
    })
    .catch(function(error){
      console.error('An error occurred when attempting to '+current_action
        +' leave request '+request_id+' by user '+req.user.id+' Error: '+error
      );
      req.session.flash_error('Failed to '+current_action);
      return res.redirect_with_session('../');
    });
  };

};

router.post(
  '/reject/',
  leave_request_action({
    action              : 'reject',
    leave_action_method : 'promise_to_reject',
  })
);

router.post(
  '/approve/',
  leave_request_action({
    action              : 'approve',
    leave_action_method : 'promise_to_approve',
  })
);

router.post('/cancel/', function(req, res){

  var request_id = validator.trim( req.param('request') );

  Promise.try(function(){
    return req.user.promise_cancelable_leaves()
  })
  .then(function(leaves){
     var leave_to_cancel = _.find(leaves, function(leave){
        return String(leave.id) === String(request_id);
     });

    if ( ! leave_to_cancel ) {
      throw new Error('Given leave request is not amoung those current user can cancel');
    }

    return Promise.resolve(leave_to_cancel);
  })
  .then(function(leave){
    return leave.promise_to_cancel()
      .then(function(){ return Promise.resolve(leave)});
  })
  .then(function(leave){
    return leave.reload({
      include : [
        {model : req.app.get('db_model').User, as : 'user'},
        {model : req.app.get('db_model').User, as : 'approver'},
        {model : req.app.get('db_model').LeaveType, as : 'leave_type' },
      ],
    });
  })
  .then(function(leave){

    var Email = new EmailTransport();

    return Email.promise_leave_request_cancel_emails({
      leave : leave,
    })
    .then(function(){
      return Promise.resolve(leave);
    });
  })
  .then(function(leave){
    req.session.flash_message('The leave request was canceled');
  })
  .catch(function(error){
    console.log('An error occurred: '+error);
    req.session.flash_error('Failed to cancel leave request');
  })
  .finally(function(){
    return res.redirect_with_session('/requests/');
  });
});

router.post(
  '/revoke/',
  function(req, res){
    var request_id = validator.trim( req.param('request') );

    // TODO NOTE revoke action now could be made from more then one place,
    // so make sure that user is redirected to correct place

    if (!validator.isNumeric(request_id)){
      req.session.flash_error('Failed to revoke leave request');
    }

    if ( req.session.flash_has_errors() ) {
      console.error(
        'Got validation errors when revoking leave request for user ' + req.user.id
      );

      return res.redirect_with_session('../');
    }

    Promise.try(function(){
      return Promise.join(
        // Get user's leaves
        req.user.promise_my_active_leaves_ever(),
        // Get all leaves from users supervised by current user
        req.user
          .promise_users_I_can_manage()
          .then(function(users){
            return Promise.all(
              _.map(
                users,
                function(user){
                  return user.promise_my_active_leaves_ever();
                }
              ))
              .then(function(array_of_leave_arrays){
                return Promise.resolve(_.flatten(array_of_leave_arrays, true));
              });
          }),
        function(users_leaves, supervised_leaves){
          // Compose all leaves into one new array
          return Promise.resolve(users_leaves.concat(supervised_leaves));
      });
    })
    .then(function(leaves){
       var leave_to_process = _.find(leaves, function(leave){
          return String(leave.id) === String(request_id)
            && leave.is_approved_leave();
       });

       if (! leave_to_process) {
         throw new Error('Provided ID '+request_id
           +' does not correspond to any leave requests to be revoked by user '
           + req.user.id
          );
       }

       return leave_to_process.promise_to_revoke();
    })
    .then(function(processed_leave){
      return processed_leave.reload({
        include : [
          {model : req.app.get('db_model').User, as : 'user'},
          {model : req.app.get('db_model').User, as : 'approver'},
          {model : req.app.get('db_model').LeaveType, as : 'leave_type' },
        ],
      });
    })
    .then(function(processed_leave){

      var Email = new EmailTransport();

      return Email.promise_leave_request_revoke_emails({
        leave  : processed_leave,
      })
      .then(function(){
        return Promise.resolve(processed_leave);
      });
    })
    .then(function(processed_leave){
      req.session.flash_message(
        'You have requested leave to be revoked. '
        + (
          processed_leave.user.is_auto_approve()
          ? ''
          : 'Your supervisor needs to approve it'
        )
      );

      return res.redirect_with_session('../');
    })
    .catch(function(error){
      console.error('An error occurred when attempting to revoke leave request '
          +request_id+' by user '+req.user.id+' Error: '+error
      );
      req.session.flash_error('Failed to revoke leave request');
      return res.redirect_with_session('../');
    });
  }
);

router.post('/ldap_password_reset/', function (req, res) {

  let old_pass = req.param('current_password'),
      new_pass = req.param('new_password'),
      new_pass_repeat = req.param('new_password_again'),
      user = req.user.dataValues.email.split('@')[0],
      change_pass_header = {
        uri: `http://${user}:${old_pass}@10.0.10.3:8080/users/${user}`,
        method: 'PATCH',
        contentType: 'application/json',
        json: [{
          "operation": "replace",
          "field": "userPassword",
          "value" : new_pass
        }]
      };

  if (new_pass !== new_pass_repeat) {
    req.session.flash_error('Password confirmation isn\'t the same as new password');
    return res.redirect_with_session('/requests/');
  }

  if (old_pass === new_pass) {
    req.session.flash_error('New and old one passwords are the same strings');
    return res.redirect_with_session('/requests/');
  }

  console.log('Change pass header:', change_pass_header.uri);

  request(change_pass_header.uri + '?_prettyPrint=true', function (error, response, body) {
    if (error || JSON.parse(body)._id !== user) {
      req.session.flash_error('Error on server #1:\n' + error + body.message);
      return res.redirect_with_session('/requests/');
    } else {
      request(change_pass_header, function (err, resp, bd) {
        if (err || bd._id !== user) {
          req.session.flash_error(bd.code + '\nError on server #2:\n' + err);
          return res.redirect_with_session('/requests/');
        } else {
          req.session.flash_message('Password changed successfully');
          return res.redirect_with_session('/requests/');
        }
      });
    }
  })
});

module.exports = router;
